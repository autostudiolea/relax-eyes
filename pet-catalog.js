(function installRelaxEyesPetCatalog(global) {
  function normalizeActionNames(rawActions) {
    if (!Array.isArray(rawActions)) return [];
    const names = [];
    const seen = new Set();
    for (const action of rawActions) {
      const name = typeof action === "string" ? action : action?.name;
      const normalized = String(name || "").trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      names.push(normalized);
    }
    return names;
  }

  function normalizeAssetPath(value) {
    const path = String(value || "").trim();
    if (!path) return "";
    return path.startsWith("/") ? path : `/${path}`;
  }

  function normalizePack(pack) {
    if (!pack || typeof pack.id !== "string" || !pack.engine) return null;
    const assets = pack.assets || {};
    const standard = pack.standard || {};
    const hit = pack.hit || {};
    const actions = pack.actions || {};
    const focusPrefix = typeof hit.focusPrefix === "string" ? hit.focusPrefix.trim() : "";
    const skeleton = assets.skeleton || "";
    const source = normalizeAssetPath(assets.source);
    const frames = Array.isArray(assets.frames)
      ? assets.frames.map(normalizeAssetPath).filter(Boolean)
      : [];
    const spritesheet = normalizeAssetPath(assets.spritesheet);
    const metadata = normalizeAssetPath(assets.metadata);
    return {
      id: pack.id,
      label: pack.name || pack.id,
      engine: pack.engine,
      version: pack.version || "0.1.0",
      skeleton,
      atlas: assets.atlas || "",
      source,
      frames,
      spritesheet,
      metadata,
      skeletonFormat: skeleton.toLowerCase().endsWith(".json") ? "json" : "binary",
      initialAnimation: actions.initial || "Relax",
      initialLoop: true,
      fitScale: Number.isFinite(Number(standard.fitScale)) ? Number(standard.fitScale) : 0.68,
      focusPrefix,
      hitMode: hit.mode || (focusPrefix ? "focus-prefix" : "visible-bounds"),
      hitPadding: Number.isFinite(Number(hit.padding)) ? Number(hit.padding) : 0.02,
      standard,
      animationAliases: actions.aliases || {},
      baseAnimations: normalizeActionNames(actions.raw),
      actions,
      capabilities: pack.capabilities || {},
      preview: pack.preview || null,
      calibration: pack.calibration || {},
      petPack: pack,
    };
  }

  async function fetchJson(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response.json();
  }

  async function load() {
    const catalog = await fetchJson("/pet-packs/catalog.json");
    const pets = Array.isArray(catalog.packs)
      ? catalog.packs.map(normalizePack).filter((pet) => {
        if (!pet) return false;
        if (pet.engine === "spine") return Boolean(pet.skeleton && pet.atlas);
        if (pet.engine === "image") return Boolean(pet.source || pet.frames.length);
        if (pet.engine === "sprite") return Boolean(pet.spritesheet && pet.metadata);
        if (pet.engine === "codex-webp") return Boolean(pet.spritesheet);
        return false;
      })
      : [];
    if (!pets.length) throw new Error("pet-packs/catalog.json has no usable pet packs");
    return { pets, source: "pet-packs", catalog };
  }

  const api = Object.freeze({ load, normalizePack });
  global.RelaxEyesPetCatalog = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
