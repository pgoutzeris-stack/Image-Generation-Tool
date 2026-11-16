-- Kosten je Bild (USD, inkl. aller Versuche und CI-Prüfung). Ältere Einträge bleiben leer.
alter table public.image_gen_history add column if not exists cost_usd numeric(10,4);
