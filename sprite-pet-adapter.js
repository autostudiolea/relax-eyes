(function installRelaxEyesSpritePetAdapter(global) {
  const referenceBounds = global.RelaxEyesSpinePetAdapter?.REFERENCE_MODEL_BOUNDS
    || { width: 370, height: 418 };

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function loadImage(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Sprite sheet failed to load: ${source}`));
      image.src = source;
    });
  }

  async function loadJson(source) {
    const response = await fetch(source, { cache: "no-store" });
    if (!response.ok) throw new Error(`Sprite metadata failed to load: ${source} (${response.status})`);
    return response.json();
  }

  function normalizeFrame(raw, fallbackId) {
    const source = raw?.frame && typeof raw.frame === "object" ? raw.frame : raw;
    if (!source || typeof source !== "object") return null;
    const id = String(source.id || source.name || fallbackId || "").trim();
    const frame = {
      id,
      x: Math.round(finite(source.x, 0)),
      y: Math.round(finite(source.y, 0)),
      width: Math.round(finite(source.width, 0)),
      height: Math.round(finite(source.height, 0)),
      pivotX: Math.max(0, Math.min(1, finite(source.pivotX, 0.5))),
      pivotY: Math.max(0, Math.min(1, finite(source.pivotY, 1))),
    };
    if (!frame.id || frame.width <= 0 || frame.height <= 0 || frame.x < 0 || frame.y < 0) return null;
    return frame;
  }

  function normalizeFrames(rawFrames) {
    if (Array.isArray(rawFrames)) {
      return rawFrames.map((frame, index) => normalizeFrame(frame, `frame-${index + 1}`)).filter(Boolean);
    }
    if (!rawFrames || typeof rawFrames !== "object") return [];
    return Object.entries(rawFrames)
      .map(([id, frame]) => normalizeFrame({ ...(frame || {}), id: frame?.id || id }, id))
      .filter(Boolean);
  }

  function animationFrameIds(value) {
    const list = Array.isArray(value) ? value : value?.frames;
    return Array.isArray(list)
      ? list.map((frame) => typeof frame === "string" ? frame : frame?.id || frame?.frame).filter(Boolean)
      : [];
  }

  function animationFps(value) {
    return Math.max(1, Math.min(30, finite(value?.fps, 8)));
  }

  function animationDuration(name) {
    const normalized = String(name || "").toLowerCase();
    if (/walk|move|run|step/.test(normalized)) return 1.6;
    if (/sleep|rest/.test(normalized)) return 3.4;
    if (/idle|relax|breathe/.test(normalized)) return 3.2;
    return 1.1;
  }

  class SpriteAnimationState {
    constructor(adapter) {
      this.adapter = adapter;
      this.current = null;
      this.queue = [];
    }

    createEntry(name, loop) {
      const duration = this.adapter.animationDuration(name);
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

  class SpritePetAdapter {
    constructor(model) {
      this.model = model || {};
      this.image = null;
      this.metadata = null;
      this.frames = [];
      this.frameMap = new Map();
      this.animations = {};
      this.rawAnimations = [];
      this.initialAnimationName = null;
      this.bounds = null;
      this.frameScale = 1;
      this.skeleton = null;
    }

    availableAnimationNames() {
      return this.rawAnimations.slice();
    }

    animationDuration(name) {
      const definition = this.animations[name];
      const frameCount = definition?.frames?.length || 0;
      if (frameCount) return Math.max(0.2, frameCount / animationFps(definition));
      return animationDuration(name);
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
      const animations = this.rawAnimations.map((name) => ({ name, duration: this.animationDuration(name) }));
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

    normalizeAnimationDefinitions(metadata) {
      const definitions = metadata?.animations && typeof metadata.animations === "object"
        ? metadata.animations
        : {};
      this.animations = Object.fromEntries(Object.entries(definitions).map(([name, value]) => [name, {
        frames: animationFrameIds(value),
        fps: animationFps(value),
        loop: value?.loop !== false,
      }]));
      const validNames = Object.entries(this.animations)
        .filter(([, definition]) => definition.frames.some((id) => this.frameMap.has(id)))
        .map(([name]) => name);
      this.rawAnimations = Array.isArray(this.model.baseAnimations) && this.model.baseAnimations.length
        ? this.model.baseAnimations.filter((name) => validNames.includes(name))
        : validNames;
      if (!this.rawAnimations.length) this.rawAnimations = validNames.length ? validNames : ["idle"];
      if (!this.animations.idle && this.frames.length) {
        this.animations.idle = { frames: [this.frames[0].id], fps: 6, loop: true };
        if (!this.rawAnimations.includes("idle")) this.rawAnimations.unshift("idle");
      }
    }

    async load() {
      if (!this.model.spritesheet || !this.model.metadata) {
        throw new Error(`Sprite pack ${this.model.id || "unknown"} is missing spritesheet or metadata`);
      }
      const [metadata, image] = await Promise.all([
        loadJson(this.model.metadata),
        loadImage(this.model.spritesheet),
      ]);
      this.metadata = metadata;
      this.image = image;
      this.frames = normalizeFrames(metadata.frames);
      if (!this.frames.length) throw new Error(`Sprite pack ${this.model.id || "unknown"} has no frame rectangles`);
      this.frameMap = new Map(this.frames.map((frame) => [frame.id, frame]));
      this.normalizeAnimationDefinitions(metadata);
      const maxFrameWidth = Math.max(...this.frames.map((frame) => frame.width));
      const maxFrameHeight = Math.max(...this.frames.map((frame) => frame.height));
      const standard = this.model.standard || metadata.standard || {};
      const maxWidth = Math.max(1, finite(standard.width, referenceBounds.width));
      const maxHeight = Math.max(1, finite(standard.height, referenceBounds.height));
      let width = maxWidth;
      let height = width * maxFrameHeight / maxFrameWidth;
      if (height > maxHeight) {
        height = maxHeight;
        width = height * maxFrameWidth / maxFrameHeight;
      }
      this.frameScale = width / maxFrameWidth;
      this.bounds = {
        offset: { x: -width / 2, y: 0 },
        size: { x: width, y: height },
      };
      this.initialAnimationName = this.resolveAnimationName(this.model.initialAnimation || metadata.initialAnimation || "idle");
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
      return new SpriteAnimationState(this);
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
      const animationName = this.resolveAnimationName(entry?.animation?.name || this.initialAnimationName || "idle");
      const definition = this.animations[animationName];
      const sequence = definition?.frames?.map((id) => this.frameMap.get(id)).filter(Boolean) || [];
      const frames = sequence.length ? sequence : this.frames;
      const fps = animationFps(definition);
      return frames[Math.floor((Number(entry?.time) || 0) * fps) % frames.length] || this.frames[0];
    }

    draw(context, width, height, viewport, bounds, root, entry) {
      context.clearRect(0, 0, width, height);
      const frame = this.frameFor(entry);
      if (!this.image || !frame || !viewport || !bounds) return;
      const worldLeft = viewport.centerX - viewport.worldWidth / 2;
      const worldTop = viewport.centerY + viewport.worldHeight / 2;
      const drawWidth = frame.width * this.frameScale;
      const drawHeight = frame.height * this.frameScale;
      const frameLeft = bounds.offset.x + bounds.size.x / 2 - drawWidth * frame.pivotX;
      const frameBottom = bounds.offset.y + bounds.size.y - drawHeight * (1 - frame.pivotY);
      const left = ((frameLeft - worldLeft) / viewport.worldWidth) * width;
      const top = ((worldTop - (frameBottom + drawHeight)) / viewport.worldHeight) * height;
      const pixelWidth = (drawWidth / viewport.worldWidth) * width;
      const pixelHeight = (drawHeight / viewport.worldHeight) * height;
      const rootX = (Number(root?.x) || 0) / viewport.worldWidth * width;
      const rootY = -(Number(root?.y) || 0) / viewport.worldHeight * height;
      const centerX = left + pixelWidth / 2 + rootX;
      const centerY = top + pixelHeight / 2 + rootY;
      const scaleX = Number(root?.scaleX) || 1;
      const scaleY = Number(root?.scaleY) || 1;
      context.save();
      context.translate(centerX, centerY);
      context.rotate((Number(root?.rotation) || 0) * Math.PI / 180);
      context.scale(scaleX, scaleY);
      context.drawImage(this.image, frame.x, frame.y, frame.width, frame.height, -pixelWidth / 2, -pixelHeight / 2, pixelWidth, pixelHeight);
      context.restore();
    }

    dispose() {
      this.image = null;
    }
  }

  const api = Object.freeze({ SpritePetAdapter });
  global.RelaxEyesSpritePetAdapter = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
