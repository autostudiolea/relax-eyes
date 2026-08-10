# Relax Eyes Desktop

一个基于 Tauri 2、Spine WebGL 和本地 Codex Hook 的 Windows 桌面宠物。应用默认使用瑶，默认动作是 `Relax`，每 20 分钟提醒一次休息眼睛。

## 当前能力

- Tauri 便携版运行，不再保留 Electron 入口或 Electron 构建链。
- 多个 Spine 角色切换；每个角色只显示自己实际拥有的动作。
- 统一角色参考尺寸、角色校准记录、左右朝向、透明像素命中、拖动和贴边。
- 待机时从当前角色原始动作中随机播放，动作序列不会伪造新的 Spine 动作。
- 眼睛休息、周报和 Codex 提示统一使用宠物气泡、声音和独立提示样式。
- Codex 等待确认使用黄色持续气泡，完成使用绿色短提示，失败使用红色短提示；点击宠物只确认“已看到”，不会自动批准或拒绝 Codex 权限。
- 运行时支持已审核的 PNG/WebP 单图宠物、旧版 `sprite` 图集包和 Codex 固定网格 `pet.json + spritesheet.webp` 角色包。新增素材不需要修改 Rust 或渲染核心。

## 运行和构建

运行时只需要 Windows 10/11 和 Microsoft Edge WebView2 Runtime，不需要 Node.js、npm 或 Rust。开发和构建需要 Node.js、npm、Rust、Cargo 和 `cargo-tauri`。

```powershell
npm run tauri:dev
npm run tauri:portable
```

便携版输出到 `dist-tauri/`，通常是 `Relax-Eyes-Tauri-Portable.exe`。如果旧版 EXE 仍在运行，打包脚本会保留旧文件并生成带数字后缀的新文件；测试新版前请关闭旧版，避免多个实例共享数据目录。

Tauri 的前端资源会先生成到项目内的 `web-dist/`，Cargo 缓存和构建目标也使用项目内目录。程序不会自动安装 WebView2、修改 PATH、注册表、系统服务或计划任务。

## 本地状态和数据

便携版的运行数据位于 EXE 同级 `data/`：

- `state.json`：当前使用的角色、朝向、窗口位置和新的四组设置结构。
- `codex-pet-endpoint.json`：随机端口和一次性令牌，只绑定 `127.0.0.1`。
- `codex-pet-queue.jsonl`：尚未确认的 Codex 通知队列。

旧 Electron 版本的 `main.cjs`、`preload.cjs`、根目录 `state.json` 和旧状态字段不再迁移或兼容。

## Codex 本地提示

宠物运行时会在 `data/codex-pet-endpoint.json` 创建本地端点。Hook 脚本随项目和便携版一起提供，Codex CLI 用户需要在自己的用户级 `CODEX_HOME/hooks.json` 中注册 Hook。下面的 `<PET_DIR>` 必须替换为便携版目录的绝对路径：

```json
{
  "hooks": {
    "PermissionRequest": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "commandWindows": "node \"<PET_DIR>\\scripts\\codex-pet-hook.cjs\"",
        "timeout": 2
      }]
    }],
    "PostToolUse": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "commandWindows": "node \"<PET_DIR>\\scripts\\codex-pet-hook.cjs\"",
        "timeout": 2
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "commandWindows": "node \"<PET_DIR>\\scripts\\codex-pet-hook.cjs\"",
        "timeout": 2
      }]
    }],
    "SubagentStop": [{
      "hooks": [{
        "type": "command",
        "commandWindows": "node \"<PET_DIR>\\scripts\\codex-pet-hook.cjs\"",
        "timeout": 2
      }]
    }]
  }
}
```

保存后重启 Codex CLI，并在会话中执行 `/hooks` 让 CLI 重新读取并信任 Hook。关闭宠物、端点不存在或 Codex 提示开关关闭时，Hook 会静默结束，不会阻塞 Codex。官方行为说明见 [Codex Hooks 文档](https://learn.chatgpt.com/docs/hooks)。

Hook 采用回合级失败判定：`PostToolUse` 遇到 PowerShell/Bash 非零退出时只记录内部失败候选，不会立即发送红色提示；主线程 `Stop` 会结合同一 `session_id + turn_id` 的最终结果再决定是否通知。命令随后被修复、测试通过或正常完成时只发送绿色完成提示。

单独出现 upstream、API、网络、连接重置、HTTP 5xx 或超时等瞬时错误会被静默忽略。只有最终回合明确未完成且需要用户手动重试、修复、处理或确认时，才发送一次红色失败提示。`SubagentStop` 不再直接通知失败，子任务失败只有在主回合最终无法完成时才会影响结果。

开发阶段可使用项目内发送器验证本地链路：

```powershell
npm run codex:send -- --type permission_request --status waiting_confirmation --summary "请确认本地测试"
npm run codex:send -- --type task_completed --status completed --summary "本地测试完成"
npm run codex:send -- --type task_failed --status failed --summary "本地失败测试"
```

## 角色包

角色包的运行时目录是 `pet-packs/`，`pets.json` 只作为现有 Spine 包的生成输入，不参与运行时回退。检查现有资源：

```powershell
npm run pet-packs:validate
npm run pet-packs:previews
```

更新角色包版本时只保留当前 manifest：

```powershell
npm run pet-packs:update -- --id yao --version 1.0.1
```

Codex 角色的原始 `pet.json` 和 `spritesheet.webp` 不随 Git 仓库提交。请从 [PetDex](https://petdex.dev/zh) 获取遵守 Codex 宠物标准的角色文件。仓库已忽略 `assets/*/pet.json` 和 `assets/*/spritesheet.webp`，这些文件只用于本地构建，不会被误加入提交。

将每个角色的两个文件放入 `relax-eyes-desktop` 同级的 `role/<角色id>/` 目录，例如：

```text
F:\myapp\relax-eyes\role\<角色id>\pet.json
F:\myapp\relax-eyes\role\<角色id>\spritesheet.webp
```

然后在 `relax-eyes-desktop` 目录执行导入、预览生成、校验和构建：

```powershell
npm run pet-packs:import-codex -- --replace
npm run pet-packs:previews
npm run pet-packs:validate
npm run tauri:portable
```

导入器会从同级 `role/` 读取角色，并在本地生成被忽略的 `assets/<角色id>/` 文件，同时更新 `pet-packs/` 清单。没有下载资源时，`pet-packs:validate` 和便携版构建不会通过。运行时会按 `engine` 分开处理：Spine 角色保留原有 Spine 行为组合；Codex 角色使用固定的 `idle`、`running-right`、`running-left`、`waving`、`jumping`、`failed`、`waiting`、`running`、`review` 状态。休息提醒对 Codex 角色使用实际方向对应的 `running-right` 或 `running-left`，不会调用 Spine 的 `Move` 动作。

## 来源和版权

本仓库中的部分 Spine 模型来自 [Ark-Models](https://github.com/isHarryh/Ark-Models)。本仓库中所有素材其版权归属上海鹰角网络有限公司所有。不得用于商业用途，不得损害版权方的利益。

项目也使用或参考了 [OpenPets](https://github.com/alvinunreal/openpets) 的部分桌面宠物相关内容。其代码许可证和版权说明保存在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目不主张拥有角色模型、立绘、Spine 数据或相关素材的版权。
