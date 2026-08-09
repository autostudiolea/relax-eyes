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

  function normalizePack(pack) {
    if (!pack || typeof pack.id !== "string" || !pack.engine) return null;
    const assets = pack.assets || {};
    const standard = pack.standard || {};
    const hit = pack.hit || {};
    const actions = pack.actions || {};
    const focusPrefix = typeof hit.focusPrefix === "string" ? hit.focusPrefix.trim() : "";
    const skeleton = assets.skeleton || "";
    return {
      id: pack.id,
      label: pack.name || pack.id,
      engine: pack.engine,
      skeleton,
      atlas: assets.atlas || "",
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
      petPack: pack,
    };
  }

  function normalizeLegacyPet(pet) {
    if (!pet || typeof pet.id !== "string" || !pet.skeleton || !pet.atlas) return null;
    return {
      ...pet,
      engine: "spine",
      hitMode: pet.focusPrefix ? "focus-prefix" : "visible-bounds",
      hitPadding: 0.02,
      standard: {
        referenceModel: "tutu",
        width: 360,
        height: 360,
        fitScale: Number.isFinite(Number(pet.fitScale)) ? Number(pet.fitScale) : 0.68,
        anchor: { x: 0.5, y: 1 },
        baseline: 0.92,
        safeMargin: { left: 0.02, top: 0.02, right: 0.02, bottom: 0.02 },
      },
    };
  }

  async function fetchJson(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response.json();
  }

  async function load() {
    let catalogError = null;
    try {
      const catalog = await fetchJson("/pet-packs/catalog.json");
      const pets = Array.isArray(catalog.packs)
        ? catalog.packs.map(normalizePack).filter((pet) => pet?.engine === "spine" && pet.skeleton && pet.atlas)
        : [];
      if (pets.length) return { pets, source: "pet-packs", catalog };
      catalogError = new Error("pet-packs/catalog.json has no usable Spine packs");
    } catch (error) {
      catalogError = error;
    }

    try {
      const legacyPets = await fetchJson("/pets.json");
      const pets = Array.isArray(legacyPets) ? legacyPets.map(normalizeLegacyPet).filter(Boolean) : [];
      if (pets.length) return { pets, source: "pets.json", catalogError };
    } catch (error) {
      throw new Error(`pet catalog load failed: ${error.message}; ${catalogError?.message || "catalog unavailable"}`);
    }
    throw new Error(`pet catalog has no usable models: ${catalogError?.message || "unknown error"}`);
  }

  const api = Object.freeze({ load, normalizePack, normalizeLegacyPet });
  global.RelaxEyesPetCatalog = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
