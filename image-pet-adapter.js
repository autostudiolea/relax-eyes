(function installRelaxEyesImagePetAdapter(global) {
  const referenceBounds = global.RelaxEyesSpinePetAdapter?.REFERENCE_MODEL_BOUNDS
    || { width: 370, height: 418 };

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function loadImage(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Image pet asset failed to load: ${source}`));
      image.src = source;
    });
  }

  function animationDuration(name) {
    const normalized = String(name || "").toLowerCase();
    if (/walk|move|run|step/.test(normalized)) return 1.6;
    if (/sleep|rest/.test(normalized)) return 3.4;
    if (/idle|relax|breathe/.test(normalized)) return 3.2;
    return 1.1;
  }

  class ImageAnimationState {
    constructor(adapter) {
      this.adapter = adapter;
      this.current = null;
      this.queue = [];
    }

    createEntry(name, loop) {
      const duration = animationDuration(name);
      return {
        animation: { name, duration },
        loop: Boolean(loop),
        time: 0,
        timeScale: 1,
        isComplete() {
          return !this.loop && this.time >= this.animation.duration;
        },
      };
    }

    update(delta) {
      if (!this.current) return;
      this.current.time += Math.max(0, Number(delta) || 0) * this.current.timeScale;
      if (!this.current.isComplete() || !this.queue.length) return;
      const next = this.queue.shift();
      this.current = next.entry;
    }

    apply() {}

    setAnimation(_track, name, loop) {
      this.queue = [];
      this.current = this.createEntry(name, loop);
      return this.current;
    }

    addAnimation(_track, name, loop, delay = 0) {
      const entry = this.createEntry(name, loop);
      this.queue.push({ entry, delay: Math.max(0, Number(delay) || 0) });
      return entry;
    }

    getCurrent() {
      return this.current;
    }
  }

  class ImagePetAdapter {
    constructor(model) {
      this.model = model || {};
      this.images = [];
      this.sources = unique([this.model.source, ...(this.model.frames || [])]);
      this.rawAnimations = [];
      this.initialAnimationName = null;
      this.bounds = null;
      this.skeleton = null;
    }

    availableAnimationNames() {
      return this.rawAnimations.slice();
    }

    resolveAnimationName(name) {
      const aliases = this.model.animationAliases || {};
      const candidates = unique([
        aliases[name],
        name,
        name === "Relax" || name === "Idle" ? aliases.Relax : null,
        name === "Relax" || name === "Idle" ? aliases.Idle : null,
        name === "Relax" || name === "Idle" ? this.initialAnimationName : null,
        this.initialAnimationName,
      ]);
      return candidates.find((candidate) => this.rawAnimations.includes(candidate))
        || this.rawAnimations[0]
        || null;
    }

    createSkeleton() {
      const root = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
      const animations = this.rawAnimations.map((name) => ({ name, duration: animationDuration(name) }));
      const data = {
        animations,
        findAnimation(name) {
          return animations.find((animation) => animation.name === name) || null;
        },
      };
      return {
        bones: [root],
        data,
        updateWorldTransform() {},
        getBounds(offset, size) {
          offset.x = this.adapterBounds.offset.x;
          offset.y = this.adapterBounds.offset.y;
          size.x = this.adapterBounds.size.x;
          size.y = this.adapterBounds.size.y;
        },
        adapterBounds: this.bounds,
      };
    }

    async load() {
      if (!this.sources.length) throw new Error(`Image pack ${this.model.id || "unknown"} has no image source`);
      this.images = await Promise.all(this.sources.map(loadImage));
      const image = this.images[0];
      const naturalWidth = Math.max(1, Number(image.naturalWidth) || 1);
      const naturalHeight = Math.max(1, Number(image.naturalHeight) || 1);
      const aspect = naturalWidth / naturalHeight;
      const standard = this.model.standard || {};
      const maxWidth = Math.max(1, Number(standard.width) || referenceBounds.width);
      const maxHeight = Math.max(1, Number(standard.height) || referenceBounds.height);
      let height = maxHeight;
      let width = height * aspect;
      if (width > maxWidth) {
        width = maxWidth;
        height = width / aspect;
      }
      this.bounds = {
        offset: { x: -width / 2, y: 0 },
        size: { x: width, y: height },
      };
      this.rawAnimations = Array.isArray(this.model.baseAnimations) && this.model.baseAnimations.length
        ? this.model.baseAnimations.slice()
        : ["idle"];
      this.initialAnimationName = this.resolveAnimationName(this.model.initialAnimation || "idle");
      this.skeleton = this.createSkeleton();
      this.skeleton.adapterBounds = this.bounds;
      return {
        adapter: this,
        assetManager: null,
        skeleton: this.skeleton,
        rawAnimations: this.rawAnimations.slice(),
        initialAnimationName: this.initialAnimationName,
        setupBounds: this.bounds,
        bounds: this.bounds,
        animationEnvelope: this.bounds,
      };
    }

    createAnimationState() {
      return new ImageAnimationState(this);
    }

    collectBounds() {
      return this.bounds;
    }

    collectHitPolygons() {
      return [];
    }

    transformBounds(bounds, root, scale = 1) {
      const rootX = Number(root?.x) || 0;
      const rootY = Number(root?.y) || 0;
      const x1 = rootX + (bounds.offset.x - rootX) * scale;
      const y1 = rootY + (bounds.offset.y - rootY) * scale;
      const x2 = rootX + (bounds.offset.x + bounds.size.x - rootX) * scale;
      const y2 = rootY + (bounds.offset.y + bounds.size.y - rootY) * scale;
      return {
        offset: { x: Math.min(x1, x2), y: Math.min(y1, y2) },
        size: { x: Math.abs(x2 - x1), y: Math.abs(y2 - y1) },
      };
    }

    frameFor(entry) {
      if (this.images.length <= 1) return this.images[0];
      const name = String(entry?.animation?.name || this.initialAnimationName || "idle").toLowerCase();
      const isIdle = name === String(this.initialAnimationName || "idle").toLowerCase()
        || /idle|relax|sleep|rest/.test(name);
      if (isIdle) return this.images[0];
      const index = Math.floor((Number(entry?.time) || 0) * 3) % this.images.length;
      return this.images[index];
    }

    renderKey(entry) {
      if (this.images.length <= 1) return "static";
      const name = String(entry?.animation?.name || this.initialAnimationName || "idle").toLowerCase();
      if (name === String(this.initialAnimationName || "idle").toLowerCase()
        || /idle|relax|sleep|rest/.test(name)) return "idle:0";
      return `${name}:${Math.floor((Number(entry?.time) || 0) * 3) % this.images.length}`;
    }

    draw(context, width, height, viewport, bounds, root, entry) {
      context.clearRect(0, 0, width, height);
      const image = this.frameFor(entry);
      if (!image || !viewport || !bounds) return;
      const worldLeft = viewport.centerX - viewport.worldWidth / 2;
      const worldTop = viewport.centerY + viewport.worldHeight / 2;
      const left = ((bounds.offset.x - worldLeft) / viewport.worldWidth) * width;
      const top = ((worldTop - (bounds.offset.y + bounds.size.y)) / viewport.worldHeight) * height;
      const drawWidth = (bounds.size.x / viewport.worldWidth) * width;
      const drawHeight = (bounds.size.y / viewport.worldHeight) * height;
      const rootX = (Number(root?.x) || 0) / viewport.worldWidth * width;
      const rootY = -(Number(root?.y) || 0) / viewport.worldHeight * height;
      const centerX = left + drawWidth / 2 + rootX;
      const centerY = top + drawHeight / 2 + rootY;
      const scaleX = Number(root?.scaleX) || 1;
      const scaleY = Number(root?.scaleY) || 1;
      context.save();
      context.translate(centerX, centerY);
      context.rotate((Number(root?.rotation) || 0) * Math.PI / 180);
      context.scale(scaleX, scaleY);
      context.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
      context.restore();
    }

    dispose() {}
  }

  const api = Object.freeze({ ImagePetAdapter });
  global.RelaxEyesImagePetAdapter = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
