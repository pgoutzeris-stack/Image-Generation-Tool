import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2.110.8";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const ALLOWED_MODELS = new Set([
  "gemini-3-pro-image",
  "gemini-3.1-flash-image",
  "gemini-2.5-flash-image",
  "gemini-3.1-flash-image-preview",
]);
const ALLOWED_ASPECTS = new Set(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]);
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_REFERENCE_BASE64_LENGTH = 12_000_000;
const LOGO_PLACEMENTS: Record<string, string> = {
  "top-left": "oben links mit sicherem Abstand zu den Bildrändern",
  "top-right": "oben rechts mit sicherem Abstand zu den Bildrändern",
  "bottom-left": "unten links mit sicherem Abstand zu den Bildrändern",
  "bottom-right": "unten rechts mit sicherem Abstand zu den Bildrändern",
  "bottom-center": "unten mittig mit sicherem Abstand zum Bildrand",
  center: "klar sichtbar in der Bildmitte",
  integrated: "natürlich und glaubwürdig als Bestandteil des Motivs",
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ error: { message } }, status);
}

async function getUser(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

// Referenzbilder der Stile liegen auf GitHub Pages; die Funktion lädt sie selbst,
// damit die Anfrage klein bleibt (Anfragen über ca. 512 KB hängen am Gateway).
const PAGES_BASE = "https://pgoutzeris-stack.github.io/Image-Generation-Tool/";
const ASSET_PATH_RE = /^assets\/(master-styles\/[a-z0-9-]+|portrait-master(-hell)?)\.jpg$/;
const assetCache = new Map<string, { data: string; mimeType: string }>();

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

async function loadAsset(path: unknown) {
  const clean = String(path ?? "").split("?")[0];
  if (!ASSET_PATH_RE.test(clean)) throw new Error("Referenzpfad nicht erlaubt.");
  const cached = assetCache.get(clean);
  if (cached) return cached;
  const res = await fetch(PAGES_BASE + clean);
  if (!res.ok) throw new Error(`Referenzbild nicht ladbar (${res.status}).`);
  const asset = { data: bytesToBase64(new Uint8Array(await res.arrayBuffer())), mimeType: "image/jpeg" };
  assetCache.set(clean, asset);
  return asset;
}

async function loadAssets(list: unknown, max: number) {
  const paths = Array.isArray(list) ? list.slice(0, max) : [];
  return await Promise.all(paths.map(loadAsset));
}

// Google-Listenpreise in USD je 1 Mio. Token (Stand 11/2026, ai.google.dev/gemini-api/docs/pricing).
// image = Bild-Ausgabetokens, text = Text- und Denk-Ausgabetokens.
const PRICES: Record<string, { input: number; image: number; text: number }> = {
  "gemini-3-pro-image": { input: 2.0, image: 120.0, text: 12.0 },
  "gemini-3.1-flash-image": { input: 0.25, image: 60.0, text: 1.5 },
  "gemini-2.5-flash-image": { input: 0.30, image: 30.0, text: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.10, image: 0, text: 0.40 },
  "gemini-2.5-flash": { input: 0.30, image: 0, text: 2.50 },
};

function costFromUsage(model: string, parsed: Record<string, any> | null) {
  const price = PRICES[model];
  const usage = parsed?.usageMetadata;
  if (!price || !usage) return 0;
  const input = Number(usage.promptTokenCount || 0);
  const candidates = Number(usage.candidatesTokenCount || 0);
  const details = Array.isArray(usage.candidatesTokensDetails) ? usage.candidatesTokensDetails : [];
  const imageTokens = details
    .filter((d: { modality?: string }) => d?.modality === "IMAGE")
    .reduce((sum: number, d: { tokenCount?: number }) => sum + Number(d.tokenCount || 0), 0);
  const textTokens = Math.max(0, candidates - imageTokens) + Number(usage.thoughtsTokenCount || 0);
  return (input * price.input + imageTokens * price.image + textTokens * price.text) / 1_000_000;
}

function clientCost(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 5) : 0;
}

function readReference(body: Record<string, unknown>, dataKey: string, mimeKey: string) {
  const data = typeof body[dataKey] === "string" ? body[dataKey] : "";
  const mimeType = typeof body[mimeKey] === "string" ? body[mimeKey] : "";
  if (!data && !mimeType) return null;
  if (!data || !mimeType) throw new Error("Referenzbild ist unvollständig.");
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) throw new Error("Nicht unterstütztes Referenzbild-Format.");
  if (data.length > MAX_REFERENCE_BASE64_LENGTH) throw new Error("Referenzbild ist zu groß.");
  return { data, mimeType };
}

function buildSystemInstruction(
  stylePrompt: string,
  hasStyleReference: boolean,
  hasLogoReference: boolean,
  logoPlacement: string,
  inputImageCount = 0,
  seriesReferenceCount = 0,
) {
  const sections = [
    "Du bist ein professioneller Art Director und Bildgenerator. Erzeuge genau das vom Nutzer beschriebene Motiv.",
  ];
  if (inputImageCount > 0 && stylePrompt) {
    sections.push(
      `VERBINDLICHER ARBEITSAUFTRAG FÜR DIE EINGABEBILDER (Image 1 bis Image ${inputImageCount}, in dieser Reihenfolge übergeben):\n${stylePrompt}`,
    );
  } else if (stylePrompt) {
    sections.push(
      `VERBINDLICHE STILVORGABE:\n${stylePrompt}\nDie Stilvorgabe bestimmt ausschließlich die visuelle Ausführung. Sie darf Motiv, Fakten und ausdrückliche Anforderungen des Nutzers nicht ersetzen.`,
    );
  }
  if (seriesReferenceCount > 0) {
    sections.push(
      `SERIENREFERENZEN: Die ${seriesReferenceCount} als Serienreferenz markierten Bilder sind freigegebene Beispiele dieser Bildserie. Halte ihr Qualitätsniveau, ihre Bildsprache, Lichtführung, Farbwelt und ihren Bildaufbau ein, damit das neue Bild erkennbar zur selben Serie gehört. Was genau übernommen wird, regelt die verbindliche Stilvorgabe. Übernimm daraus weder Motive noch Marken, Logos, Wasserzeichen oder Schrift, sofern die Stilvorgabe das nicht ausdrücklich verlangt.`,
    );
  }
  if (hasStyleReference) {
    sections.push(
      "STILREFERENZ: Das erste als Stilreferenz markierte Bild dient ausschließlich als Vorlage für Farbwelt, Licht, Komposition, Materialität, Textur und Bildsprache. Kopiere weder Motiv noch Personen, Schrift oder Logos daraus.",
    );
  }
  if (hasLogoReference) {
    sections.push(
      `LOGOREFERENZ: Das als Logo markierte Bild muss in Form, Farben, Proportionen und Schreibweise möglichst originalgetreu erhalten bleiben. Nicht neu zeichnen, umdeuten oder durch Fantasieschrift ersetzen. Platziere es ${LOGO_PLACEMENTS[logoPlacement]}. Halte es gut lesbar und vermeide Überlagerungen mit Gesichtern oder wichtigen Inhalten.`,
    );
  }
  sections.push(
    "QUALITÄT: Liefere ein zusammenhängendes, professionelles Bild ohne Wasserzeichen, zufällige Zusatzlogos, ungewollte Schrift oder technische Artefakte.",
  );
  return sections.join("\n\n");
}

async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return errorResponse("Supabase environment is not configured", 500);
  }

  const user = await getUser(req);
  if (!user) return errorResponse("Nicht angemeldet oder Session abgelaufen.", 401);
  const authenticatedUser = user;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  const action = String(body.action ?? "");
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  async function logUsage(operation: string, model: string, parsed: Record<string, any>, ok: boolean, startedAt: number, imageCount = 0, errorCode?: string) {
    const usage = parsed?.usageMetadata || {};
    const cached = Number(usage.cachedContentTokenCount || 0);
    const { error } = await admin.schema("shared").from("ai_provider_usage").insert({
      app: "image-generation", operation, provider: "google", model,
      status: ok ? "success" : "error", user_id: authenticatedUser.id,
      input_tokens: Math.max(0, Number(usage.promptTokenCount || 0) - cached),
      cached_input_tokens: cached,
      output_tokens: Number(usage.candidatesTokenCount || 0),
      thinking_tokens: Number(usage.thoughtsTokenCount || 0),
      image_count: imageCount, duration_ms: Date.now() - startedAt,
      error_code: errorCode || null,
    });
    // Verbrauchs-Logging darf eine Generierung nie abbrechen.
    if (error) console.error(`Usage tracking failed: ${error.message}`);
  }

  async function isAdmin() {
    const { data } = await admin
      .schema("users")
      .from("profiles")
      .select("app_role")
      .eq("id", authenticatedUser.id)
      .maybeSingle();
    return data?.app_role === "admin";
  }

  async function readGoogleApiKey() {
    const { data, error } = await admin.rpc("image_generation_read_google_api_key");
    if (error) throw new Error(error.message);
    return data ? String(data) : "";
  }

  if (action === "settings_status") {
    const { data, error } = await admin.rpc("image_generation_google_key_configured");
    if (error) return errorResponse(error.message, 500);
    return jsonResponse({ configured: Boolean(data) });
  }

  if (action === "save_google_api_key") {
    if (!(await isAdmin())) return errorResponse("Forbidden", 403);
    const apiKey = String(body.apiKey ?? "").trim();
    if (!apiKey || apiKey.length < 20) return errorResponse("Ungültiger API-Key", 400);
    const { error } = await admin.rpc("image_generation_upsert_google_api_key", {
      p_api_key: apiKey,
    });
    if (error) return errorResponse(error.message, 500);
    return jsonResponse({ ok: true, configured: true });
  }

  if (action === "get_history") {
    const requestedLimit = Number(body.limit ?? 50);
    const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 50, 1), 100);
    const adminUser = await isAdmin();
    let query = admin
      .from("image_gen_history")
      .select("id,user_id,user_name,user_email,prompt,model_id,model_label,aspect,style_id,mime_type,created_at,cost_usd")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (!adminUser) query = query.eq("user_id", authenticatedUser.id);
    const { data, error } = await query;
    if (error) return errorResponse(error.message, 500);
    const rows = data || [];
    const userIds = [...new Set(rows.map((r: { user_id: string }) => r.user_id).filter(Boolean))];
    let avatars: Record<string, string | null> = {};
    if (userIds.length) {
      const { data: profiles } = await admin.schema("users").from("profiles").select("id,avatar_url").in("id", userIds);
      avatars = Object.fromEntries((profiles || []).map((p: { id: string; avatar_url: string | null }) => [p.id, p.avatar_url]));
    }
    return jsonResponse({ history: rows.map((r: { user_id: string }) => ({ ...r, user_avatar_url: avatars[r.user_id] ?? null })) });
  }

  if (action === "get_history_image") {
    const itemId = String(body.id ?? "");
    if (!itemId) return errorResponse("id required", 400);
    const adminUser = await isAdmin();
    let query = admin
      .from("image_gen_history")
      .select("image_data,mime_type")
      .eq("id", itemId);
    if (!adminUser) query = query.eq("user_id", authenticatedUser.id);
    const { data, error } = await query.maybeSingle();
    if (error) return errorResponse(error.message, 500);
    if (!data?.image_data) return errorResponse("Bild nicht gefunden.", 404);
    return jsonResponse({ image: data });
  }

  if (action === "delete_history_item") {
    const itemId = String(body.id ?? "");
    if (!itemId) return errorResponse("id required", 400);
    const adminUser = await isAdmin();
    let query = admin.from("image_gen_history").delete().eq("id", itemId);
    if (!adminUser) query = query.eq("user_id", authenticatedUser.id);
    const { error } = await query;
    if (error) return errorResponse(error.message, 500);
    return jsonResponse({ ok: true });
  }

  if (action === "improve_style_prompt") {
    const stylePrompt = String(body.stylePrompt ?? "").trim().slice(0, 6000);
    if (stylePrompt.length < 5) return errorResponse("Stilidee ist zu kurz.", 400);
    let apiKey = "";
    try {
      apiKey = await readGoogleApiKey();
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "API-Key konnte nicht gelesen werden.", 500);
    }
    if (!apiKey) return errorResponse("Google API-Key nicht hinterlegt.", 503);

    const improveStartedAt = Date.now();
    const improveResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: "Du optimierst deutsche Systemvorgaben für KI-Bildgenerierung. Bewahre die kreative Absicht. Korrigiere Rechtschreibung und strukturiere präzise nach Bildmedium, Farbwelt, Licht, Komposition, Material/Textur, Stimmung und Ausschlüssen. Erfinde keine Marken oder Motive. Antworte ausschließlich mit der fertigen Stilvorgabe, ohne Einleitung oder Markdown-Codeblock.",
            }],
          },
          contents: [{ role: "user", parts: [{ text: stylePrompt }] }],
          generationConfig: { temperature: 0.35, maxOutputTokens: 1200 },
        }),
      },
    );
    const improveText = await improveResponse.text();
    let improveParsed: Record<string, any> = {};
    try { improveParsed = JSON.parse(improveText); } catch { /* provider returned non-JSON */ }
    await logUsage("improve_style_prompt", "gemini-2.5-flash", improveParsed, improveResponse.ok, improveStartedAt, 0, improveResponse.ok ? undefined : `http_${improveResponse.status}`);
    if (!improveResponse.ok) {
      try {
        return errorResponse(improveParsed?.error?.message || "Stilvorgabe konnte nicht verbessert werden.", improveResponse.status);
      } catch {
        return errorResponse("Stilvorgabe konnte nicht verbessert werden.", improveResponse.status);
      }
    }
    try {
      const parsed = JSON.parse(improveText);
      const improvedPrompt = parsed?.candidates?.[0]?.content?.parts
        ?.map((part: { text?: string }) => part.text || "")
        .join("\n")
        .trim()
        .replace(/^```(?:text)?\s*/i, "")
        .replace(/\s*```$/, "");
      if (!improvedPrompt) return errorResponse("Keine Verbesserung erhalten.", 502);
      return jsonResponse({ improvedPrompt });
    } catch {
      return errorResponse("Ungültige Antwort des KI-Modells.", 502);
    }
  }

  if (action === "finalize_image") {
    // ROOTS-CI-Prüfung des Rohbilds (vor Logo-Einsatz) mit günstigem Flash-Lite-Modell, danach Verlaufseintrag.
    let rawImage;
    let finalImage;
    try {
      rawImage = readReference(body, "rawImageData", "rawMimeType");
      finalImage = readReference(body, "finalImageData", "finalMimeType");
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Bild ist ungültig.", 400);
    }
    if (!rawImage || !finalImage) return errorResponse("Bild fehlt", 400);
    const rootsLogoStyle = body.rootsLogo === true;
    let apiKey = "";
    try { apiKey = await readGoogleApiKey(); } catch { /* handled below */ }
    if (!apiKey) return errorResponse("Google API-Key nicht hinterlegt", 503);

    const checkPrompt = [
      "Du prüfst ein KI-generiertes Bild gegen die ROOTS-Corporate-Identity. Antworte nur mit JSON.",
      "roots_mark: true, wenn irgendwo im Bild das Wort ROOTS (auch RCOTS, R∞TS, ähnliche Schreibweisen), ein ROOTS-Logo, ein Unendlich-Zeichen als Logo oder eine Nachahmung davon zu sehen ist.",
      "corner_clear: immer true. foreign_logo: immer false. Logos und Namen anderer Marken sind erlaubt und kein Verstoß.",
      "reason: ein kurzer deutscher Satz.",
    ].join("\n");
    const checkStartedAt = Date.now();
    const checkRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: checkPrompt }, { inlineData: rawImage }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                roots_mark: { type: "BOOLEAN" },
                corner_clear: { type: "BOOLEAN" },
                foreign_logo: { type: "BOOLEAN" },
                reason: { type: "STRING" },
              },
              required: ["roots_mark", "corner_clear", "foreign_logo", "reason"],
            },
          },
        }),
      },
    );
    const checkText = await checkRes.text();
    let checkParsed: Record<string, any> = {};
    try { checkParsed = JSON.parse(checkText); } catch { /* ignore */ }
    await logUsage("ci_check", "gemini-2.5-flash-lite", checkParsed, checkRes.ok, checkStartedAt);
    let verdict: Record<string, unknown> | null = null;
    try { verdict = JSON.parse(checkParsed?.candidates?.[0]?.content?.parts?.[0]?.text ?? ""); } catch { /* ignore */ }
    if (!checkRes.ok || !verdict) return jsonResponse({ ok: false, checked: false, reason: "CI-Prüfung nicht erreichbar" });
    // Verstoß ist nur ein vom Modell gezeichnetes ROOTS-Zeichen; Fremdmarken sind erlaubt.
    const ok = verdict.roots_mark === false;
    const totalCost = clientCost(body.generationCostUsd) + costFromUsage("gemini-2.5-flash-lite", checkParsed);

    if (ok) {
      const { data: profile } = await admin.schema("users").from("profiles").select("full_name").eq("id", authenticatedUser.id).maybeSingle();
      const { error: historyError } = await admin.from("image_gen_history").insert({
        user_id: authenticatedUser.id,
        user_name: profile?.full_name || authenticatedUser.email?.split("@")[0] || "Unbekannt",
        user_email: authenticatedUser.email || "",
        prompt: String(body.promptText ?? "").slice(0, 6000),
        model_id: String(body.modelId ?? "").slice(0, 100),
        model_label: String(body.modelLabel ?? "").slice(0, 100),
        aspect: ALLOWED_ASPECTS.has(String(body.aspect)) ? String(body.aspect) : "1:1",
        style_id: String(body.styleId ?? "").slice(0, 100) || null,
        image_data: finalImage.data,
        mime_type: finalImage.mimeType,
        cost_usd: Number(totalCost.toFixed(4)),
      });
      if (historyError) console.error("History save failed:", historyError.message);
    }
    return jsonResponse({ ok, checked: true, ...verdict, costUsd: totalCost });
  }

  if (action !== "generate_image") return errorResponse("Unknown action", 400);

  const modelId = String(body.modelId ?? "");
  const modelLabel = String(body.modelLabel ?? modelId).slice(0, 100);
  const promptText = String(body.promptText ?? "").trim().slice(0, 6000);
  const stylePrompt = String(body.stylePrompt ?? "").trim().slice(0, 16000);
  const styleId = String(body.styleId ?? "").slice(0, 100);
  const requestedAspect = String(body.aspect ?? "1:1");
  const aspect = ALLOWED_ASPECTS.has(requestedAspect) ? requestedAspect : "1:1";
  const requestedLogoPlacement = String(body.logoPlacement ?? "bottom-right");
  const logoPlacement = LOGO_PLACEMENTS[requestedLogoPlacement] ? requestedLogoPlacement : "bottom-right";

  if (!ALLOWED_MODELS.has(modelId)) return errorResponse(`Modell '${modelId}' nicht erlaubt`, 400);
  if (!promptText) return errorResponse("Prompt fehlt", 400);

  let styleReference;
  let logoReference;
  const inputImages: Array<{ data: string; mimeType: string }> = [];
  const seriesReferences: Array<{ data: string; mimeType: string }> = [];
  try {
    styleReference = readReference(body, "styleReferenceData", "styleReferenceMimeType")
      || readReference(body, "refImageData", "refImageMimeType");
    logoReference = readReference(body, "logoReferenceData", "logoReferenceMimeType");
    const rawInputs = Array.isArray(body.inputImages) ? body.inputImages.slice(0, 2) : [];
    for (const item of rawInputs) {
      const ref = readReference((item ?? {}) as Record<string, unknown>, "data", "mimeType");
      if (ref) inputImages.push(ref);
    }
    const rawSeries = Array.isArray(body.seriesReferences) ? body.seriesReferences.slice(0, 3) : [];
    for (const item of rawSeries) {
      const ref = readReference((item ?? {}) as Record<string, unknown>, "data", "mimeType");
      if (ref) seriesReferences.push(ref);
    }
    for (const asset of await loadAssets(body.inputImagePaths, 2 - inputImages.length)) inputImages.push(asset);
    for (const asset of await loadAssets(body.seriesRefPaths, 3 - seriesReferences.length)) seriesReferences.push(asset);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Referenzbild ist ungültig.", 400);
  }

  let apiKey = "";
  try {
    apiKey = await readGoogleApiKey();
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "API-Key konnte nicht gelesen werden.", 500);
  }
  if (!apiKey) return errorResponse("Google API-Key nicht hinterlegt — bitte in KI-Einstellungen speichern", 503);

  const parts: Array<Record<string, unknown>> = [{ text: `BILDAUFTRAG:\n${promptText}` }];
  inputImages.forEach((image, index) => {
    parts.push({ text: `Image ${index + 1}:` });
    parts.push({ inlineData: image });
  });
  seriesReferences.forEach((image, index) => {
    parts.push({ text: `SERIENREFERENZ ${index + 1}:` });
    parts.push({ inlineData: image });
  });
  if (styleReference) {
    parts.push({ text: "STILREFERENZ (nur visuelle Bildsprache übernehmen):" });
    parts.push({ inlineData: styleReference });
  }
  if (logoReference) {
    parts.push({ text: `LOGOREFERENZ (originalgetreu ${LOGO_PLACEMENTS[logoPlacement]} einbetten):` });
    parts.push({ inlineData: logoReference });
  }

  const generationStartedAt = Date.now();
  const googleRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: buildSystemInstruction(
              stylePrompt,
              Boolean(styleReference),
              Boolean(logoReference),
              logoPlacement,
              inputImages.length,
              seriesReferences.length,
            ),
          }],
        },
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: { aspectRatio: aspect },
        },
      }),
    },
  );

  const responseText = await googleRes.text();
  let parsedResponse: Record<string, any> = {};
  try { parsedResponse = JSON.parse(responseText); } catch { /* provider returned non-JSON */ }
  const generatedImageCount = parsedResponse?.candidates?.[0]?.content?.parts?.filter(
    (part: { inlineData?: { data?: string } }) => Boolean(part.inlineData?.data),
  ).length || 0;
  await logUsage("generate_image", modelId, parsedResponse, googleRes.ok, generationStartedAt, generatedImageCount, googleRes.ok ? undefined : `http_${googleRes.status}`);
  if (googleRes.ok) {
    try {
      const imagePart = parsedResponse?.candidates?.[0]?.content?.parts?.find(
        (part: { inlineData?: { data?: string } }) => part.inlineData?.data,
      ) as { inlineData: { data: string; mimeType?: string } } | undefined;

      if (imagePart?.inlineData?.data && body.deferHistory !== true) {
        const { data: profile } = await admin
          .schema("users")
          .from("profiles")
          .select("full_name")
          .eq("id", authenticatedUser.id)
          .maybeSingle();
        const { error: historyError } = await admin.from("image_gen_history").insert({
          user_id: authenticatedUser.id,
          user_name: profile?.full_name || authenticatedUser.email?.split("@")[0] || "Unbekannt",
          user_email: authenticatedUser.email || "",
          prompt: promptText,
          model_id: modelId,
          model_label: modelLabel,
          aspect,
          style_id: styleId || null,
          image_data: imagePart.inlineData.data,
          mime_type: imagePart.inlineData.mimeType || "image/png",
          cost_usd: Number((clientCost(body.priorCostUsd) + costFromUsage(modelId, parsedResponse)).toFixed(4)),
        });
        if (historyError) console.error("History save failed:", historyError.message);
      }
    } catch (error) {
      console.error("History response parsing failed:", error);
    }
  }

  if (googleRes.ok && parsedResponse?.candidates) {
    parsedResponse._costUsd = costFromUsage(modelId, parsedResponse);
    return jsonResponse(parsedResponse);
  }
  return new Response(responseText, {
    status: googleRes.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  try {
    return await handleRequest(req);
  } catch (error) {
    console.error("Unhandled image-generation error:", error);
    return errorResponse(error instanceof Error ? error.message : "Interner Fehler", 500);
  }
});
