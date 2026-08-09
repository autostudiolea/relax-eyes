(function installRelaxEyesCodexPetAdapter(global) {
  const format = global.RelaxEyesCodexPetFormat;
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
      image.onerror = () => reject(new Error(`Codex WebP 图集加载失败：${source}`));
      image.src = source;
    });
  }

  function animationFps(value, fallback = 6) {
    return Math.max(1, Math.min(30, finite(value?.fps, fallback)));
  }

  class CodexAnimationState {
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

  class CodexPetAdapter {
    constructor(model) {
      this.model = model || {};
      this.image = null;
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
      const durations = Array.isArray(definition?.durations)
        ? definition.durations
        : format?.durations?.[name];
      if (frameCount && Array.isArray(durations) && durations.length) {
        return Math.max(0.2, durations.slice(0, frameCount).reduce(
          (total, duration) => total + Math.max(1, finite(duration, 1000 / animationFps(definition))),
          0,
        ) / 1000);
      }
      return frameCount
        ? Math.max(0.2, frameCount / animationFps(definition))
        : 1;
    }

    resolveAnimationName(name) {
      const aliases = { ...(format?.aliases || {}), ...(this.model.animationAliases || {}) };
      const requested = String(name || "").trim();
      const candidates = unique([
        aliases[requested],
        requested,
        aliases[requested.toLowerCase()],
        requested.toLowerCase(),
        requested === "Relax" || requested === "Idle" ? aliases.Relax : null,
        requested === "Relax" || requested === "Idle" ? this.initialAnimationName : null,
        this.initialAnimationName,
        "idle",
      ]);
      return candidates
        .map((candidate) => this.rawAnimations.find((animation) => (
          animation === candidate || animation.toLowerCase() === String(candidate).toLowerCase()
        )))
        .find(Boolean)
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

    async load() {
      if (!format || !this.model.spritesheet) {
        throw new Error(`Codex 角色 ${this.model.id || "unknown"} 缺少固定图集格式支持`);
      }
      this.image = await loadImage(this.model.spritesheet);
      const width = Number(this.image.naturalWidth || this.image.width);
      const height = Number(this.image.naturalHeight || this.image.height);
      if (width !== format.width || height !== format.height) {
        throw new Error(`Codex 图集必须是 ${format.width} x ${format.height}，当前为 ${width} x ${height}`);
      }

      const visibleColumns = format.detectVisibleColumns(this.image);
      const layout = format.buildFrames(visibleColumns);
      this.frames = layout.frames;
      this.frameMap = new Map(this.frames.map((frame) => [frame.id, frame]));
      this.animations = layout.animations;
      const validNames = Object.entries(this.animations)
        .filter(([, definition]) => definition.frames.some((id) => this.frameMap.has(id)))
        .map(([name]) => name);
      const configuredNames = Array.isArray(this.model.baseAnimations) ? this.model.baseAnimations : [];
      this.rawAnimations = configuredNames.length
        ? configuredNames.filter((name) => validNames.includes(name))
        : validNames;
      if (!this.rawAnimations.length) this.rawAnimations = validNames;
      if (!this.rawAnimations.length) throw new Error(`Codex 角色 ${this.model.id || "unknown"} 图集中没有可用动作`);

      const standard = this.model.standard || {};
      const maxWidth = Math.max(1, finite(standard.width, 360));
      const maxHeight = Math.max(1, finite(standard.height, 360));
      let drawWidth = maxWidth;
      let drawHeight = drawWidth * format.cellHeight / format.cellWidth;
      if (drawHeight > maxHeight) {
        drawHeight = maxHeight;
        drawWidth = drawHeight * format.cellWidth / format.cellHeight;
      }
      this.frameScale = drawWidth / format.cellWidth;
      this.bounds = {
        offset: { x: -drawWidth / 2, y: 0 },
        size: { x: drawWidth, y: drawHeight },
      };
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
      return new CodexAnimationState(this);
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
      const frames = definition?.frames?.map((id) => this.frameMap.get(id)).filter(Boolean) || [];
      const sequence = frames.length ? frames : this.frames;
      if (!sequence.length) return null;
      const fallbackDuration = 1000 / animationFps(definition, format.fps[animationName] || 6);
      const durations = Array.isArray(definition?.durations) && definition.durations.length
        ? definition.durations.slice(0, sequence.length).map((duration) => Math.max(1, finite(duration, fallbackDuration)))
        : Array.from({ length: sequence.length }, () => fallbackDuration);
      const totalDuration = durations.reduce((total, duration) => total + duration, 0);
      let elapsed = Math.max(0, Number(entry?.time) || 0) * 1000;
      if (entry?.loop) {
        elapsed %= totalDuration;
      } else {
        elapsed = Math.min(elapsed, Math.max(0, totalDuration - 1));
      }
      let cursor = 0;
      for (let index = 0; index < sequence.length; index += 1) {
        cursor += durations[index];
        if (elapsed < cursor) return sequence[index];
      }
      return sequence[sequence.length - 1] || this.frames[0];
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
      // Codex frames use a bottom pivot. Keep the rendered frame on the same
      // baseline as the normalized hit bounds instead of shifting it upward.
      const frameBottom = bounds.offset.y + bounds.size.y - drawHeight * frame.pivotY;
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

  const api = Object.freeze({ CodexPetAdapter });
  global.RelaxEyesCodexPetAdapter = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
