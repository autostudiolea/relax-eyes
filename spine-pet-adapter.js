(function installRelaxEyesSpinePetAdapter(global) {
  const REFERENCE_MODEL_BOUNDS = Object.freeze({ width: 370, height: 418 });
  const MAX_ENVELOPE_SAMPLES = 24;

  function uniqueCandidates(candidates) {
    return candidates.filter((candidate, index, list) => candidate && list.indexOf(candidate) === index);
  }

  function waitForAssets(assetManager) {
    return new Promise((resolve, reject) => {
      const startedAt = performance.now();
      const poll = () => {
        if (assetManager.hasErrors()) {
          reject(new Error(Object.values(assetManager.getErrors()).join("\n")));
          return;
        }
        if (assetManager.isLoadingComplete()) {
          resolve();
          return;
        }
        if (performance.now() - startedAt > 15000) {
          reject(new Error("Spine model assets timed out"));
          return;
        }
        global.setTimeout(poll, 30);
      };
      poll();
    });
  }

  class SpinePetAdapter {
    constructor(model, gl) {
      this.model = model || {};
      this.gl = gl;
      this.spine = global.spine;
      if (!this.spine?.webgl) throw new Error("Spine WebGL runtime is unavailable");
      const hit = this.model.hit || {};
      this.hitMode = this.model.hitMode || hit.mode || (this.model.focusPrefix ? "focus-prefix" : "visible-bounds");
      this.focusPrefix = typeof this.model.focusPrefix === "string"
        ? this.model.focusPrefix.trim()
        : (typeof hit.focusPrefix === "string" ? hit.focusPrefix.trim() : "");
      this.assetManager = null;
      this.skeleton = null;
      this.skeletonData = null;
      this.rawAnimations = [];
      this.initialAnimationName = null;
    }

    static get REFERENCE_MODEL_BOUNDS() {
      return REFERENCE_MODEL_BOUNDS;
    }

    static availableAnimationNames(skeletonData) {
      const names = [];
      const seen = new Set();
      for (const animation of skeletonData?.animations || []) {
        const name = String(animation?.name || "").trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        names.push(name);
      }
      return names;
    }

    static resolveAnimationName(name, model, availableNames) {
      const aliases = model?.animationAliases || {};
      const candidates = [aliases[name], name];
      if (name === "Relax" || name === "Idle") {
        candidates.push(aliases.Relax, aliases.Idle, "Relax", "Idle");
      }
      return uniqueCandidates(candidates).find((candidate) => availableNames.includes(candidate)) || null;
    }

    availableAnimationNames() {
      return this.rawAnimations.slice();
    }

    resolveAnimationName(name) {
      const candidates = [
        this.model.animationAliases?.[name],
        name,
      ];
      if (name === "Relax" || name === "Idle") {
        candidates.push(
          this.model.animationAliases?.Relax,
          this.model.animationAliases?.Idle,
          "Relax",
          "Idle",
          this.initialAnimationName,
        );
      }
      const resolved = uniqueCandidates(candidates)
        .find((candidate) => this.skeletonData?.findAnimation(candidate));
      return resolved || null;
    }

    isFocusAttachment(slot, attachment) {
      if (!this.focusPrefix) return true;
      const slotName = slot.data.name || "";
      const attachmentName = attachment?.name || "";
      return slotName.startsWith(this.focusPrefix) || attachmentName.startsWith(this.focusPrefix);
    }

    collectBounds(skeleton) {
      if (this.focusPrefix) {
        const vertices = [];
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        let matched = false;
        for (const slot of skeleton.drawOrder) {
          const attachment = slot.getAttachment();
          if (!this.isFocusAttachment(slot, attachment)) continue;
          if (attachment instanceof this.spine.RegionAttachment) {
            vertices.length = 8;
            attachment.computeWorldVertices(slot.bone, vertices, 0, 2);
          } else if (attachment instanceof this.spine.MeshAttachment) {
            vertices.length = attachment.worldVerticesLength;
            attachment.computeWorldVertices(slot, 0, attachment.worldVerticesLength, vertices, 0, 2);
          } else {
            continue;
          }
          matched = true;
          for (let index = 0; index < vertices.length; index += 2) {
            minX = Math.min(minX, vertices[index]);
            minY = Math.min(minY, vertices[index + 1]);
            maxX = Math.max(maxX, vertices[index]);
            maxY = Math.max(maxY, vertices[index + 1]);
          }
        }
        if (matched && maxX > minX && maxY > minY) {
          return {
            offset: new this.spine.Vector2(minX, minY),
            size: new this.spine.Vector2(maxX - minX, maxY - minY),
          };
        }
      }
      const offset = new this.spine.Vector2();
      const size = new this.spine.Vector2();
      skeleton.getBounds(offset, size, []);
      if (!Number.isFinite(size.x) || !Number.isFinite(size.y) || size.x <= 0 || size.y <= 0) {
        throw new Error("Spine model has no valid visible bounds");
      }
      return { offset, size };
    }

    collectHitPolygons(skeleton) {
      const polygons = [];
      for (const slot of skeleton.drawOrder) {
        const attachment = slot.getAttachment();
        if (!this.isFocusAttachment(slot, attachment)) continue;
        if (attachment instanceof this.spine.RegionAttachment) {
          const vertices = new Array(8);
          attachment.computeWorldVertices(slot.bone, vertices, 0, 2);
          polygons.push({ vertices, indices: [0, 1, 2, 0, 2, 3] });
        } else if (attachment instanceof this.spine.MeshAttachment) {
          const vertices = new Array(attachment.worldVerticesLength);
          attachment.computeWorldVertices(slot, 0, attachment.worldVerticesLength, vertices, 0, 2);
          const indices = Array.from(attachment.triangles || []);
          if (vertices.length >= 6 && indices.length >= 3) polygons.push({ vertices, indices });
        }
      }
      return polygons;
    }

    calculateBounds(skeleton) {
      skeleton.setToSetupPose();
      skeleton.updateWorldTransform();
      return this.collectBounds(skeleton);
    }

    mergeBounds(target, bounds) {
      const minX = bounds.offset.x;
      const minY = bounds.offset.y;
      const maxX = minX + bounds.size.x;
      const maxY = minY + bounds.size.y;
      target.minX = Math.min(target.minX, minX);
      target.minY = Math.min(target.minY, minY);
      target.maxX = Math.max(target.maxX, maxX);
      target.maxY = Math.max(target.maxY, maxY);
    }

    boundsFromExtents(extents) {
      if (!Number.isFinite(extents.minX) || !Number.isFinite(extents.maxX)
        || extents.maxX <= extents.minX || extents.maxY <= extents.minY) {
        throw new Error("Spine model has no valid animation bounds");
      }
      return {
        offset: new this.spine.Vector2(extents.minX, extents.minY),
        size: new this.spine.Vector2(extents.maxX - extents.minX, extents.maxY - extents.minY),
      };
    }

    calculateAnimationEnvelope(skeleton, selectedAnimations = skeleton.data.animations) {
      const extents = {
        minX: Number.POSITIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
      };
      for (const animation of selectedAnimations || []) {
        const duration = Math.max(0, Number(animation.duration) || 0);
        const sampleCount = duration > 0
          ? Math.min(MAX_ENVELOPE_SAMPLES, Math.max(2, Math.ceil(duration * 6)))
          : 1;
        for (let index = 0; index < sampleCount; index += 1) {
          const time = sampleCount === 1 ? 0 : duration * index / (sampleCount - 1);
          skeleton.setToSetupPose();
          animation.apply(
            skeleton,
            0,
            time,
            false,
            [],
            1,
            this.spine.MixBlend.setup,
            this.spine.MixDirection.mixIn,
          );
          skeleton.updateWorldTransform();
          this.mergeBounds(extents, this.collectBounds(skeleton));
        }
      }
      skeleton.setToSetupPose();
      skeleton.updateWorldTransform();
      return this.boundsFromExtents(extents);
    }

    calculateTypicalAnimationBounds(skeleton, animation) {
      const duration = Math.max(0, Number(animation?.duration) || 0);
      const sampleCount = duration > 0
        ? Math.min(MAX_ENVELOPE_SAMPLES, Math.max(4, Math.ceil(duration * 6)))
        : 1;
      const samples = [];
      for (let index = 0; index < sampleCount; index += 1) {
        const time = sampleCount === 1 ? 0 : duration * index / (sampleCount - 1);
        skeleton.setToSetupPose();
        animation.apply(
          skeleton,
          0,
          time,
          false,
          [],
          1,
          this.spine.MixBlend.setup,
          this.spine.MixDirection.mixIn,
        );
        skeleton.updateWorldTransform();
        samples.push(this.collectBounds(skeleton));
      }
      skeleton.setToSetupPose();
      skeleton.updateWorldTransform();
      if (!samples.length) throw new Error("Spine model has no default animation bounds");
      samples.sort((left, right) => (left.size.x * left.size.y) - (right.size.x * right.size.y));
      return samples[Math.floor(samples.length * 0.55)];
    }

    transformBounds(bounds, root, scale) {
      const rootX = Number(root?.x) || 0;
      const rootY = Number(root?.y) || 0;
      const x1 = rootX + (bounds.offset.x - rootX) * scale;
      const y1 = rootY + (bounds.offset.y - rootY) * scale;
      const x2 = rootX + (bounds.offset.x + bounds.size.x - rootX) * scale;
      const y2 = rootY + (bounds.offset.y + bounds.size.y - rootY) * scale;
      return {
        offset: new this.spine.Vector2(Math.min(x1, x2), Math.min(y1, y2)),
        size: new this.spine.Vector2(Math.abs(x2 - x1), Math.abs(y2 - y1)),
      };
    }

    async load() {
      const assets = this.model.assets || {};
      const skeletonPath = this.model.skeleton || assets.skeleton;
      const atlasPath = this.model.atlas || assets.atlas;
      if (!skeletonPath || !atlasPath) throw new Error(`Spine pack ${this.model.id || "unknown"} is missing skeleton or atlas`);
      this.assetManager = new this.spine.webgl.AssetManager(this.gl);
      const skeletonIsJson = this.model.skeletonFormat === "json" || skeletonPath.toLowerCase().endsWith(".json");
      if (skeletonIsJson) this.assetManager.loadText(skeletonPath);
      else this.assetManager.loadBinary(skeletonPath);
      this.assetManager.loadTextureAtlas(atlasPath);
      await waitForAssets(this.assetManager);

      const atlas = this.assetManager.get(atlasPath);
      const loader = new this.spine.AtlasAttachmentLoader(atlas);
      if (skeletonIsJson) {
        const skeletonJson = new this.spine.SkeletonJson(loader);
        skeletonJson.scale = 1;
        this.skeletonData = skeletonJson.readSkeletonData(this.assetManager.get(skeletonPath));
      } else {
        const skeletonBinary = new this.spine.SkeletonBinary(loader);
        skeletonBinary.scale = 1;
        this.skeletonData = skeletonBinary.readSkeletonData(this.assetManager.get(skeletonPath));
      }
      this.skeleton = new this.spine.Skeleton(this.skeletonData);
      this.rawAnimations = SpinePetAdapter.availableAnimationNames(this.skeletonData);
      this.initialAnimationName = SpinePetAdapter.resolveAnimationName(
        this.model.initialAnimation,
        this.model,
        this.rawAnimations,
      ) || this.rawAnimations[0] || null;
      const initialAnimation = this.skeletonData.findAnimation(this.initialAnimationName) || this.skeletonData.animations[0];
      const setupBounds = this.calculateBounds(this.skeleton);
      let bounds = setupBounds;
      if (initialAnimation) {
        try {
          bounds = this.calculateTypicalAnimationBounds(this.skeleton, initialAnimation);
        } catch (error) {
          console.warn(`Could not calculate default bounds for ${this.model.label || this.model.id}:`, error);
        }
      }
      let animationEnvelope = bounds;
      try {
        animationEnvelope = this.calculateAnimationEnvelope(this.skeleton);
      } catch (error) {
        console.warn(`Could not calculate animation envelope for ${this.model.label || this.model.id}:`, error);
      }
      return {
        adapter: this,
        assetManager: this.assetManager,
        skeletonData: this.skeletonData,
        skeleton: this.skeleton,
        rawAnimations: this.rawAnimations.slice(),
        initialAnimationName: this.initialAnimationName,
        initialAnimation,
        setupBounds,
        bounds,
        animationEnvelope,
      };
    }

    dispose() {
      this.assetManager?.dispose();
      this.assetManager = null;
      this.skeleton = null;
      this.skeletonData = null;
    }
  }

  global.RelaxEyesSpinePetAdapter = SpinePetAdapter;
})(typeof window !== "undefined" ? window : globalThis);
