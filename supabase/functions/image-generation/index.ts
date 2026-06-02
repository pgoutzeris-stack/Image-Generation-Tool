import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const ALLOWED_MODELS = new Set([
  "gemini-3.1-flash-image-preview",
  "gemini-2.5-flash-image",
]);

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
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return errorResponse("Supabase environment is not configured", 500);
  }

  const user = await getUser(req);
  if (!user) return errorResponse("Nicht angemeldet oder Session abgelaufen.", 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const action = String(body.action ?? "");
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  async function isAdmin() {
    const { data, error } = await admin
      .schema("users")
      .from("profiles")
      .select("app_role")
      .eq("id", user.id)
      .maybeSingle();
    return !error && data?.app_role === "admin";
  }

  if (action === "settings_status") {
    const { data, error } = await admin.rpc("image_generation_google_key_configured");
    if (error) return errorResponse(error.message, 500);
    return jsonResponse({ configured: Boolean(data) });
  }

  if (action === "save_google_api_key") {
    if (!(await isAdmin())) return errorResponse("Forbidden", 403);

    const apiKey = String(body.apiKey ?? "").trim();
    if (!apiKey || apiKey.length < 20) {
      return errorResponse("Bitte einen gültigen Google API-Key eintragen.", 400);
    }

    const { error } = await admin.rpc("image_generation_upsert_google_api_key", {
      p_api_key: apiKey,
    });
    if (error) return errorResponse(error.message, 500);
    return jsonResponse({ ok: true, configured: true });
  }

  if (action !== "generate_image") {
    return errorResponse("Unknown action", 400);
  }

  const modelId = String(body.modelId ?? "");
  const promptText = String(body.promptText ?? "");
  const aspect = String(body.aspect ?? "1:1");
  const refImageData = typeof body.refImageData === "string" ? body.refImageData : "";
  const refImageMimeType = typeof body.refImageMimeType === "string" ? body.refImageMimeType : "";

  if (!ALLOWED_MODELS.has(modelId)) return errorResponse("Model is not allowed", 400);
  if (!promptText.trim()) return errorResponse("Prompt fehlt.", 400);

  const { data: apiKey, error: keyError } = await admin.rpc("image_generation_read_google_api_key");
  if (keyError) return errorResponse(keyError.message, 500);
  if (!apiKey) return errorResponse("Google API-Key ist noch nicht in den Admin-Einstellungen hinterlegt.", 503);

  const parts: Array<Record<string, unknown>> = [{ text: promptText }];
  if (refImageData && refImageMimeType) {
    parts.push({ inlineData: { data: refImageData, mimeType: refImageMimeType } });
  }

  const googleRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(String(apiKey))}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: { aspectRatio: aspect },
        },
      }),
    },
  );

  const responseText = await googleRes.text();
  return new Response(responseText, {
    status: googleRes.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
