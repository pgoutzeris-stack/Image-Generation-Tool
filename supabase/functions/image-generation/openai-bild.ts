// OpenAI-Bildmodelle (GPT Image) neben Nano Banana. Gleicher Auftrag, gleiche
// Referenzbilder; mit Referenzen ueber /images/edits, sonst /images/generations.
// Eine Kopie liegt im Signal Layer (supabase/functions/signal-layer/openai-bild.ts).

/** USD je 1 Mio. Token, laut platform.openai.com/docs/pricing (Stand 25.11.2026). */
export const OPENAI_BILD_PREISE: Record<string, { text: number; bildEin: number; bildAus: number }> = {
  "gpt-image-2.6-sunburst": { text: 5, bildEin: 8, bildAus: 30 },
  "gpt-image-2.6-flare": { text: 5, bildEin: 8, bildAus: 30 },
  "gpt-image-2": { text: 5, bildEin: 8, bildAus: 30 },
};

export const OPENAI_BILD_STANDARD = "gpt-image-2.6-sunburst";

export function istOpenaiBildModell(modell: string): boolean {
  return Object.prototype.hasOwnProperty.call(OPENAI_BILD_PREISE, modell);
}

/** Seitenverhaeltnis in eine Groesse, Kanten durch 16 teilbar, lange Kante 1536. */
const GROESSEN: Record<string, string> = {
  "1:1": "1024x1024", "4:5": "1024x1280", "5:4": "1280x1024", "3:4": "960x1280", "4:3": "1280x960",
  "2:3": "1024x1536", "3:2": "1536x1024", "9:16": "864x1536", "16:9": "1536x864", "21:9": "1792x768",
};
export function openaiGroesse(aspect: string): string {
  return GROESSEN[aspect] || "1024x1024";
}

export type OpenaiNutzung = { input_tokens?: number; output_tokens?: number; input_tokens_details?: { text_tokens?: number; image_tokens?: number } };

export function openaiBildKostenUsd(modell: string, nutzung: OpenaiNutzung | null | undefined): number {
  const preis = OPENAI_BILD_PREISE[modell];
  if (!preis || !nutzung) return 0;
  const details = nutzung.input_tokens_details || {};
  const bildEin = Number(details.image_tokens || 0);
  const textEin = Number(details.text_tokens ?? Math.max(0, Number(nutzung.input_tokens || 0) - bildEin));
  return (textEin * preis.text + bildEin * preis.bildEin + Number(nutzung.output_tokens || 0) * preis.bildAus) / 1_000_000;
}

export type OpenaiBildEingabe = { data: string; mimeType: string; label: string };

export async function openaiBild(optionen: {
  apiKey: string; modell: string; anweisung: string; auftrag: string; bilder: OpenaiBildEingabe[]; aspect: string; timeoutMs?: number;
}): Promise<{ ok: boolean; status: number; data: string; mime: string; nutzung: OpenaiNutzung | null; fehler: string }> {
  const { apiKey, modell, anweisung, auftrag, bilder, aspect } = optionen;
  // Die Bilder tragen keine eigenen Beschriftungen; ihre Reihenfolge steht im Text.
  const liste = bilder.length
    ? `\n\nEINGABEBILDER in dieser Reihenfolge:\n${bilder.map((b, i) => `Bild ${i + 1}: ${b.label}`).join("\n")}`
    : "";
  const prompt = `${anweisung}${liste}\n\nBILDAUFTRAG:\n${auftrag}`.slice(0, 30_000);
  const groesse = openaiGroesse(aspect);
  let res: Response;
  try {
    if (bilder.length) {
      const form = new FormData();
      form.append("model", modell);
      form.append("prompt", prompt);
      form.append("size", groesse);
      form.append("n", "1");
      form.append("output_format", "jpeg");
      bilder.slice(0, 16).forEach((b, i) => {
        const bytes = Uint8Array.from(atob(b.data), (c) => c.charCodeAt(0));
        const endung = b.mimeType === "image/png" ? "png" : b.mimeType === "image/webp" ? "webp" : "jpg";
        form.append("image[]", new Blob([bytes], { type: b.mimeType }), `bild-${i + 1}.${endung}`);
      });
      res = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form,
        signal: AbortSignal.timeout(optionen.timeoutMs ?? 140_000),
      });
    } else {
      res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: modell, prompt, size: groesse, n: 1, output_format: "jpeg" }),
        signal: AbortSignal.timeout(optionen.timeoutMs ?? 140_000),
      });
    }
  } catch (e) {
    return { ok: false, status: 0, data: "", mime: "", nutzung: null, fehler: e instanceof Error ? e.message : String(e) };
  }
  const text = await res.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* kein JSON */ }
  const b64 = String(json?.data?.[0]?.b64_json || "");
  if (!res.ok || !b64) {
    return { ok: false, status: res.status, data: "", mime: "", nutzung: json?.usage || null, fehler: String(json?.error?.message || text).slice(0, 400) };
  }
  return { ok: true, status: res.status, data: b64, mime: "image/jpeg", nutzung: json.usage || null, fehler: "" };
}
