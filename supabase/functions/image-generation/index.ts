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
) {
  const sections = [
    "Du bist ein professioneller Art Director und Bildgenerator. Erzeuge genau das vom Nutzer beschriebene Motiv.",
  ];
  if (stylePrompt) {
    sections.push(
      `VERBINDLICHE STILVORGABE:\n${stylePrompt}\nDie Stilvorgabe bestimmt ausschließlich die visuelle Ausführung. Sie darf Motiv, Fakten und ausdrückliche Anforderungen des Nutzers nicht ersetzen.`,
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

Deno.serve(async (req: Request) => {
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
      .select("id,user_id,user_name,user_email,prompt,model_id,model_label,aspect,style_id,mime_type,created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (!adminUser) query = query.eq("user_id", authenticatedUser.id);
    const { data, error } = await query;
    if (error) return errorResponse(error.message, 500);
    return jsonResponse({ history: data || [] });
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
    if (!improveResponse.ok) {
      try {
        const parsed = JSON.parse(improveText);
        return errorResponse(parsed?.error?.message || "Stilvorgabe konnte nicht verbessert werden.", improveResponse.status);
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

  if (action !== "generate_image") return errorResponse("Unknown action", 400);

  const modelId = String(body.modelId ?? "");
  const modelLabel = String(body.modelLabel ?? modelId).slice(0, 100);
  const promptText = String(body.promptText ?? "").trim().slice(0, 6000);
  const stylePrompt = String(body.stylePrompt ?? "").trim().slice(0, 8000);
  const styleId = String(body.styleId ?? "").slice(0, 100);
  const requestedAspect = String(body.aspect ?? "1:1");
  const aspect = ALLOWED_ASPECTS.has(requestedAspect) ? requestedAspect : "1:1";
  const requestedLogoPlacement = String(body.logoPlacement ?? "bottom-right");
  const logoPlacement = LOGO_PLACEMENTS[requestedLogoPlacement] ? requestedLogoPlacement : "bottom-right";

  if (!ALLOWED_MODELS.has(modelId)) return errorResponse(`Modell '${modelId}' nicht erlaubt`, 400);
  if (!promptText) return errorResponse("Prompt fehlt", 400);

  let styleReference;
  let logoReference;
  try {
    styleReference = readReference(body, "styleReferenceData", "styleReferenceMimeType")
      || readReference(body, "refImageData", "refImageMimeType");
    logoReference = readReference(body, "logoReferenceData", "logoReferenceMimeType");
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
  if (styleReference) {
    parts.push({ text: "STILREFERENZ (nur visuelle Bildsprache übernehmen):" });
    parts.push({ inlineData: styleReference });
  }
  if (logoReference) {
    parts.push({ text: `LOGOREFERENZ (originalgetreu ${LOGO_PLACEMENTS[logoPlacement]} einbetten):` });
    parts.push({ inlineData: logoReference });
  }

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
  if (googleRes.ok) {
    try {
      const parsed = JSON.parse(responseText);
      const imagePart = parsed?.candidates?.[0]?.content?.parts?.find(
        (part: { inlineData?: { data?: string } }) => part.inlineData?.data,
      ) as { inlineData: { data: string; mimeType?: string } } | undefined;

      if (imagePart?.inlineData?.data) {
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
        });
        if (historyError) console.error("History save failed:", historyError.message);
      }
    } catch (error) {
      console.error("History response parsing failed:", error);
    }
  }

  return new Response(responseText, {
    status: googleRes.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
