# Relax Eyes Desktop

一个基于 Tauri 2 和 Spine 3.8 Runtime 的 Windows 桌面宠物应用，同时保留 Electron 回滚版本。

宠物会常驻桌面，在后台进行自然待机和互动动作，并按照设定的时间提醒用户休息眼睛。项目当前以图图作为默认角色，默认动作是 `Relax`。

## 功能

- 支持多个 Spine 角色模型，并在切换角色后只显示该角色实际拥有的动作。
- 右键菜单保留模型原始动作；待机时随机组合播放基础动作、停顿和轻微程序化行为。
- 支持点击、悬停、拖动和贴边交互。
- 支持调整宠物显示比例。
- 支持透明、无边框、始终置顶的桌面宠物窗口。
- 默认每 20 分钟提醒一次休息，支持自定义提醒间隔、休息时长、标题和正文。
- 提醒时播放声音、显示醒目动画，并支持点击宠物确认休息。
- 倒计时放在右键菜单中，不占用宠物本体的透明窗口区域。
- 首选 Tauri 便携 ZIP：无需单独安装 Node.js、npm 或 Electron 即可运行。
- 保留 Electron 便携构建，便于 Tauri 验收期间回滚。

## 运行环境

- Windows 10/11
- Microsoft Edge WebView2 Runtime（Tauri 运行所需）
- 开发和构建才需要 Node.js、npm、Rust、Cargo、MSVC 和 `cargo-tauri`
- Spine 3.8 Runtime 已随项目资源提供

Tauri 启动时只读检查 WebView2 注册表键。缺少运行时时会显示错误提示，不会自动下载、安装 WebView2，也不会修改系统设置。Tauri 的 WebView 数据和应用状态写入可执行文件旁的 `data` 目录。

## 开发运行

在当前目录执行：

```powershell
npm install
npm run tauri:dev
```

Electron 回滚版本仍可用：

```powershell
npm start
```

## 构建 Tauri 便携版

执行：

```powershell
npm run tauri:portable
```

生成的文件位于 `dist-tauri/`：

```text
Relax-Eyes-Tauri-Portable.zip
```

ZIP 内的 Tauri EXE 已嵌入前端、Spine Runtime 和 `assets` 角色资源，解压后无需 npm 即可运行。用户数据保存在 EXE 同级的 `data/state.json`，不会覆盖项目外的系统配置。

## 角色包元数据

`pet-packs/` 保存每个角色的 `manifest.json` 和统一的 `manifest.schema.json`。当前 Spine 角色由 `scripts/generate-pet-packs.cjs` 从 `pets.json` 生成，并可用下面的命令校验资源入口：

```powershell
npm run pet-packs:generate
npm run pet-packs:validate
```

`pet-packs/templates/image-manifest.json` 已定义图片型宠物的入口格式；图片导入和帧动画生成仍属于 TODO 的后续阶段，不会伪装成已经完成的功能。

Electron 回滚版仍可按原方式构建：

```powershell
npm run dist:portable
```

产物位于 `dist/`。

## 角色包运行时

The renderer reads `pet-packs/catalog.json` first and falls back to `pets.json` only when the generated catalog is unavailable. Both Electron and Tauri use the same normalized catalog data.

`pet-catalog.js` normalizes manifest data for the renderer and the Electron main process. `spine-pet-adapter.js` owns Spine asset loading, raw animation discovery, default-animation resolution, bounds sampling, reference-size normalization, and attachment hit geometry. A failed replacement pack leaves the currently running pet intact.

## 角色模型来源与版权声明

本项目使用的部分角色 Spine 模型文件来源于以下项目：

- [Ark-Models](https://github.com/isHarryh/Ark-Models)

模型资源来源项目中的原始版权声明如下：

> 本仓库中所有素材其版权归属 上海鹰角网络有限公司 所有。不得用于商业用途，不得损害版权方的利益。

本项目不主张拥有明日方舟角色、立绘、Spine 模型及相关素材的版权。角色素材仅应在符合原版权方、素材来源项目和相关第三方许可要求的前提下使用。未经明确授权，不应将这些素材用于商业用途、单独销售或声称其属于本项目作者。

本项目也使用或参考了 [OpenPets](https://github.com/alvinunreal/openpets) 中的部分桌面宠物相关内容，包括桌面宠物的窗口组织、交互方向和相关实现思路。OpenPets 的代码以 MIT License 发布，原项目版权归 Boring Dystopia Development 所有。

OpenPets 的原始许可文本已保存在本仓库的 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中。对 OpenPets 代码的修改和再分发应继续保留原版权声明与 MIT License 条款。
