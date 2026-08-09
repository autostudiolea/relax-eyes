use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use std::{ffi::OsStr, os::windows::ffi::OsStrExt, process::Command};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::WebviewWindowBuilder,
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Runtime, Size, State,
    WebviewUrl, WebviewWindow, WindowEvent,
};

const BASE_WINDOW_SIZE: f64 = 360.0;
const WINDOW_REFERENCE_SCALE: f64 = 0.68;
const MIN_WINDOW_SIZE: f64 = 80.0;
const MIN_INTERVAL_MS: i64 = 60 * 1000;
const MAX_INTERVAL_MS: i64 = 120 * 60 * 1000;
const DEBUG_INTERVAL_MS: i64 = 10 * 1000;
const DEFAULT_DISPLAY_SCALE: f64 = 0.35;
const MIN_DISPLAY_SCALE: f64 = 0.15;
const MAX_DISPLAY_SCALE: f64 = 1.0;
const MIN_REST_DURATION_MS: i64 = 5 * 1000;
const MAX_REST_DURATION_MS: i64 = 10 * 60 * 1000;
const DEFAULT_REST_DURATION_MS: i64 = 20 * 1000;
const DEFAULT_REMINDER_TITLE: &str = "该放松一下眼睛了";
const DEFAULT_REMINDER_BODY: &str = "看向远处 {seconds} 秒，或者点击宠物确认已经休息。";
const REMINDER_WINDOW_WIDTH: f64 = 440.0;
const REMINDER_WINDOW_HEIGHT: f64 = 210.0;
const REMINDER_WINDOW_DURATION_MS: u64 = 15 * 1000;
const EDGE_SNAP_DISTANCE: f64 = 48.0;
const MAX_CONTENT_INSET: f64 = 0.45;
const WEBVIEW2_CLIENT_ID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

#[cfg(windows)]
fn webview2_runtime_version() -> Option<String> {
    let keys = [
        format!(r"HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT_ID}"),
        format!(r"HKLM\SOFTWARE\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT_ID}"),
        format!(r"HKCU\Software\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT_ID}"),
    ];
    for key in keys {
        let Ok(output) = Command::new("reg.exe")
            .args(["query", &key, "/v", "pv"])
            .output()
        else {
            return None;
        };
        if !output.status.success() {
            continue;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let Some(version) = text
            .lines()
            .flat_map(|line| line.split_whitespace().collect::<Vec<_>>())
            .collect::<Vec<_>>()
            .windows(3)
            .find_map(|tokens| {
                if tokens[0].eq_ignore_ascii_case("pv") && tokens[1].eq_ignore_ascii_case("REG_SZ")
                {
                    Some(tokens[2].to_string())
                } else {
                    None
                }
            })
        else {
            continue;
        };
        if version
            .split('.')
            .any(|part| part.parse::<u64>().unwrap_or(0) > 0)
        {
            return Some(version);
        }
    }
    None
}

#[cfg(windows)]
fn show_webview2_error(message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

    let title: Vec<u16> = OsStr::new("Relax Eyes")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let text: Vec<u16> = OsStr::new(message)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(not(windows))]
fn webview2_runtime_version() -> Option<String> {
    Some("not-required".to_string())
}

#[cfg(not(windows))]
fn show_webview2_error(_message: &str) {}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PositionData {
    x: f64,
    y: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeState {
    model: String,
    interval_ms: i64,
    paused: bool,
    phase: String,
    next_due_at: i64,
    due_at: i64,
    position: Option<PositionData>,
    display_scale: f64,
    rest_duration_ms: i64,
    reminder_title: String,
    reminder_body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    paused_remaining_ms: Option<i64>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        let now = now_ms();
        Self {
            model: "tutu".to_string(),
            interval_ms: 20 * 60 * 1000,
            paused: false,
            phase: "active".to_string(),
            next_due_at: now + 20 * 60 * 1000,
            due_at: 0,
            position: None,
            display_scale: DEFAULT_DISPLAY_SCALE,
            rest_duration_ms: DEFAULT_REST_DURATION_MS,
            reminder_title: DEFAULT_REMINDER_TITLE.to_string(),
            reminder_body: DEFAULT_REMINDER_BODY.to_string(),
            paused_remaining_ms: None,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetDefinition {
    id: String,
    label: String,
    #[serde(default)]
    base_animations: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct PetPackActions {
    #[serde(default)]
    raw: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct PetPackDefinition {
    id: String,
    name: String,
    engine: String,
    #[serde(default)]
    actions: PetPackActions,
}

#[derive(Clone, Debug, Deserialize)]
struct PetPackCatalog {
    #[serde(default)]
    packs: Vec<PetPackDefinition>,
}

#[derive(Clone, Copy, Debug, Default)]
struct ContentInsets {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

struct AppState {
    runtime: Mutex<RuntimeState>,
    actions: Mutex<HashMap<String, Vec<String>>>,
    content_insets: Mutex<ContentInsets>,
    dragging: AtomicBool,
    mouse_ignored: AtomicBool,
    data_root: PathBuf,
    pets: Vec<PetDefinition>,
    quitting: AtomicBool,
}

#[derive(Clone, Copy, Debug)]
struct WorkArea {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Copy, Debug)]
struct WindowGeometry {
    x: f64,
    y: f64,
    size: f64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn clamp_interval(value: i64) -> i64 {
    value.clamp(MIN_INTERVAL_MS, MAX_INTERVAL_MS)
}

fn clamp_display_scale(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(MIN_DISPLAY_SCALE, MAX_DISPLAY_SCALE)
    } else {
        DEFAULT_DISPLAY_SCALE
    }
}

fn clamp_rest_duration(value: i64) -> i64 {
    value.clamp(MIN_REST_DURATION_MS, MAX_REST_DURATION_MS)
}

fn clean_text(value: Option<&Value>, fallback: &str, maximum_length: usize) -> String {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(maximum_length).collect())
        .unwrap_or_else(|| fallback.to_string())
}

fn load_pets() -> Vec<PetDefinition> {
    if let Ok(catalog) =
        serde_json::from_str::<PetPackCatalog>(include_str!("../../pet-packs/catalog.json"))
    {
        let pets = catalog
            .packs
            .into_iter()
            .filter(|pack| pack.engine == "spine")
            .map(|pack| PetDefinition {
                id: pack.id,
                label: pack.name,
                base_animations: pack.actions.raw,
            })
            .collect::<Vec<_>>();
        if !pets.is_empty() {
            return pets;
        }
    }
    serde_json::from_str(include_str!("../../pets.json")).unwrap_or_default()
}

fn load_runtime_state(path: &Path, pets: &[PetDefinition]) -> RuntimeState {
    let fallback = RuntimeState::default();
    let Ok(text) = fs::read_to_string(path) else {
        return fallback;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return fallback;
    };

    let mut state = RuntimeState {
        model: value
            .get("model")
            .and_then(Value::as_str)
            .filter(|model| pets.iter().any(|pet| pet.id == *model))
            .unwrap_or(&fallback.model)
            .to_string(),
        interval_ms: clamp_interval(
            value
                .get("intervalMs")
                .and_then(Value::as_i64)
                .unwrap_or(fallback.interval_ms),
        ),
        paused: value
            .get("paused")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        phase: if value.get("phase").and_then(Value::as_str) == Some("due") {
            "due".to_string()
        } else {
            "active".to_string()
        },
        next_due_at: value
            .get("nextDueAt")
            .and_then(Value::as_i64)
            .unwrap_or(fallback.next_due_at),
        due_at: value.get("dueAt").and_then(Value::as_i64).unwrap_or(0),
        position: value.get("position").and_then(|position| {
            Some(PositionData {
                x: position.get("x")?.as_f64()?,
                y: position.get("y")?.as_f64()?,
            })
        }),
        display_scale: clamp_display_scale(
            value
                .get("displayScale")
                .and_then(Value::as_f64)
                .unwrap_or(fallback.display_scale),
        ),
        rest_duration_ms: clamp_rest_duration(
            value
                .get("restDurationMs")
                .and_then(Value::as_i64)
                .unwrap_or(fallback.rest_duration_ms),
        ),
        reminder_title: clean_text(value.get("reminderTitle"), DEFAULT_REMINDER_TITLE, 80),
        reminder_body: clean_text(value.get("reminderBody"), DEFAULT_REMINDER_BODY, 240),
        paused_remaining_ms: value.get("pausedRemainingMs").and_then(Value::as_i64),
    };

    if state.next_due_at <= 0 {
        state.next_due_at = now_ms() + state.interval_ms;
    }
    if state.phase == "due" {
        state.paused = false;
    }
    state
}

fn save_runtime_state(app_state: &AppState) {
    let state = app_state
        .runtime
        .lock()
        .expect("runtime state mutex poisoned")
        .clone();
    if let Err(error) = fs::create_dir_all(&app_state.data_root).and_then(|_| {
        fs::write(
            app_state.data_root.join("state.json"),
            serde_json::to_vec_pretty(&state).unwrap_or_default(),
        )
    }) {
        eprintln!("Could not persist local state: {error}");
    }
}

fn snapshot(app_state: &AppState) -> Value {
    let state = app_state
        .runtime
        .lock()
        .expect("runtime state mutex poisoned")
        .clone();
    let remaining_ms = if state.phase == "active" && !state.paused {
        (state.next_due_at - now_ms()).max(0)
    } else {
        0
    };
    let actions = app_state
        .actions
        .lock()
        .expect("actions mutex poisoned")
        .clone();
    let mut value = serde_json::to_value(state).unwrap_or_else(|_| json!({}));
    if let Value::Object(object) = &mut value {
        object.insert("remainingMs".to_string(), json!(remaining_ms));
        object.insert("availableActions".to_string(), json!(actions));
    }
    value
}

fn send_state<R: Runtime>(app: &AppHandle<R>, app_state: &AppState) {
    let _ = app.emit("relax-eyes:state", snapshot(app_state));
}

fn send_event<R: Runtime>(app: &AppHandle<R>, event_type: &str, payload: Value) {
    let mut event = match payload {
        Value::Object(object) => object,
        _ => serde_json::Map::new(),
    };
    event.insert("type".to_string(), Value::String(event_type.to_string()));
    let _ = app.emit("relax-eyes:event", Value::Object(event));
}

fn window_size_for_scale(scale: f64) -> f64 {
    (BASE_WINDOW_SIZE * clamp_display_scale(scale) / WINDOW_REFERENCE_SCALE)
        .round()
        .max(MIN_WINDOW_SIZE)
}

fn inset_pixels(size: f64, value: f64) -> f64 {
    size * value.clamp(0.0, MAX_CONTENT_INSET)
}

fn monitor_work_area<R: Runtime>(app: &AppHandle<R>, x: f64, y: f64) -> Option<WorkArea> {
    let monitors = app.available_monitors().ok()?;
    let monitor = monitors
        .iter()
        .find(|monitor| {
            let scale = monitor.scale_factor().max(0.1);
            let position = monitor.position();
            let size = monitor.size();
            let left = position.x as f64 / scale;
            let top = position.y as f64 / scale;
            let right = left + size.width as f64 / scale;
            let bottom = top + size.height as f64 / scale;
            x >= left && x <= right && y >= top && y <= bottom
        })
        .or_else(|| monitors.first())?;
    let scale = monitor.scale_factor().max(0.1);
    let work_area = monitor.work_area();
    Some(WorkArea {
        x: work_area.position.x as f64 / scale,
        y: work_area.position.y as f64 / scale,
        width: work_area.size.width as f64 / scale,
        height: work_area.size.height as f64 / scale,
    })
}

fn primary_work_area<R: Runtime>(app: &AppHandle<R>) -> Option<WorkArea> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor().max(0.1);
    let work_area = monitor.work_area();
    Some(WorkArea {
        x: work_area.position.x as f64 / scale,
        y: work_area.position.y as f64 / scale,
        width: work_area.size.width as f64 / scale,
        height: work_area.size.height as f64 / scale,
    })
}

fn current_window_geometry<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<WindowGeometry, String> {
    let scale = window
        .scale_factor()
        .map_err(|error| error.to_string())?
        .max(0.1);
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let logical_position = position.to_logical(scale);
    let logical_size: LogicalSize<f64> = size.to_logical(scale);
    Ok(WindowGeometry {
        x: logical_position.x,
        y: logical_position.y,
        size: logical_size.width.max(logical_size.height),
    })
}

fn set_native_mouse_ignored<R: Runtime>(
    app: &AppHandle<R>,
    app_state: &AppState,
    ignored: bool,
) -> Result<(), String> {
    if app_state.mouse_ignored.load(Ordering::Relaxed) == ignored {
        return Ok(());
    }
    let window = app
        .get_webview_window("main")
        .ok_or("main window is missing")?;
    window
        .set_ignore_cursor_events(ignored)
        .map_err(|error| error.to_string())?;
    app_state.mouse_ignored.store(ignored, Ordering::Relaxed);
    Ok(())
}

#[cfg(windows)]
fn cursor_over_content<R: Runtime>(window: &WebviewWindow<R>, insets: ContentInsets) -> bool {
    use windows_sys::Win32::{Foundation::POINT, UI::WindowsAndMessaging::GetCursorPos};

    let mut cursor = POINT { x: 0, y: 0 };
    if unsafe { GetCursorPos(&mut cursor) } == 0 {
        return false;
    }
    let Ok(position) = window.outer_position() else {
        return false;
    };
    let Ok(size) = window.inner_size() else {
        return false;
    };
    let width = size.width as f64;
    let height = size.height as f64;
    let left = position.x as f64 + width * insets.left;
    let top = position.y as f64 + height * insets.top;
    let right = position.x as f64 + width * (1.0 - insets.right);
    let bottom = position.y as f64 + height * (1.0 - insets.bottom);
    let x = cursor.x as f64;
    let y = cursor.y as f64;
    x >= left && x <= right && y >= top && y <= bottom
}

fn clamp_position<R: Runtime>(
    app: &AppHandle<R>,
    app_state: &AppState,
    x: f64,
    y: f64,
    size: f64,
) -> PositionData {
    let area = monitor_work_area(app, x + size / 2.0, y + size / 2.0)
        .or_else(|| primary_work_area(app))
        .unwrap_or(WorkArea {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        });
    let insets = *app_state
        .content_insets
        .lock()
        .expect("content insets mutex poisoned");
    let left = area.x - inset_pixels(size, insets.left);
    let right = area.x + area.width - size + inset_pixels(size, insets.right);
    let top = area.y - inset_pixels(size, insets.top);
    let bottom = area.y + area.height - size + inset_pixels(size, insets.bottom);
    PositionData {
        x: x.clamp(left.min(right), left.max(right)),
        y: y.clamp(top.min(bottom), top.max(bottom)),
    }
}

fn set_window_geometry<R: Runtime>(
    window: &WebviewWindow<R>,
    position: PositionData,
    size: f64,
) -> Result<(), String> {
    window
        .set_size(Size::Logical(LogicalSize::new(size, size)))
        .map_err(|error| error.to_string())?;
    window
        .set_position(Position::Logical(LogicalPosition::new(
            position.x, position.y,
        )))
        .map_err(|error| error.to_string())
}

fn initial_position<R: Runtime>(
    app: &AppHandle<R>,
    app_state: &AppState,
    size: f64,
) -> PositionData {
    if let Some(position) = app_state
        .runtime
        .lock()
        .expect("runtime state mutex poisoned")
        .position
        .clone()
    {
        return clamp_position(app, app_state, position.x, position.y, size);
    }
    let area = primary_work_area(app).unwrap_or(WorkArea {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    });
    let insets = *app_state
        .content_insets
        .lock()
        .expect("content insets mutex poisoned");
    clamp_position(
        app,
        app_state,
        area.x + area.width - size + inset_pixels(size, insets.right),
        area.y + area.height - size + inset_pixels(size, insets.bottom),
        size,
    )
}

fn hide_reminder_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("reminder") {
        let _ = window.hide();
    }
}

fn reminder_position<R: Runtime>(app: &AppHandle<R>) -> PositionData {
    let (pet_x, pet_y, pet_size) = app
        .get_webview_window("main")
        .and_then(|window| {
            current_window_geometry(&window)
                .ok()
                .map(|geometry| (geometry.x, geometry.y, geometry.size))
        })
        .unwrap_or((0.0, 0.0, 0.0));
    let area = monitor_work_area(app, pet_x + pet_size / 2.0, pet_y + pet_size / 2.0)
        .or_else(|| primary_work_area(app))
        .unwrap_or(WorkArea {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        });
    let inset = 24.0;
    let max_x = (area.x + area.width - REMINDER_WINDOW_WIDTH - inset).max(area.x);
    let max_y = (area.y + area.height - REMINDER_WINDOW_HEIGHT - inset).max(area.y);
    let candidates = [
        (
            area.x + (area.width - REMINDER_WINDOW_WIDTH) / 2.0,
            area.y + inset,
        ),
        (area.x + inset, area.y + inset),
        (max_x, area.y + inset),
        (area.x + (area.width - REMINDER_WINDOW_WIDTH) / 2.0, max_y),
    ];
    let overlaps_pet = |x: f64, y: f64| {
        x < pet_x + pet_size
            && x + REMINDER_WINDOW_WIDTH > pet_x
            && y < pet_y + pet_size
            && y + REMINDER_WINDOW_HEIGHT > pet_y
    };
    let (x, y) = candidates
        .into_iter()
        .find(|(x, y)| !overlaps_pet(*x, *y))
        .unwrap_or(candidates[0]);
    PositionData {
        x: x.clamp(area.x, max_x),
        y: y.clamp(area.y, max_y),
    }
}

fn show_reminder_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let position = reminder_position(app);
    if let Some(window) = app.get_webview_window("reminder") {
        window
            .set_position(Position::Logical(LogicalPosition::new(
                position.x, position.y,
            )))
            .map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
    } else {
        let window =
            WebviewWindowBuilder::new(app, "reminder", WebviewUrl::App("reminder.html".into()))
                .title("眼睛休息提醒")
                .inner_size(REMINDER_WINDOW_WIDTH, REMINDER_WINDOW_HEIGHT)
                .position(position.x, position.y)
                .decorations(false)
                .transparent(true)
                .resizable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .shadow(false)
                .visible(false)
                .data_directory(app.state::<AppState>().data_root.join("webview-reminder"))
                .build()
                .map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
    }
    let app_handle = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(REMINDER_WINDOW_DURATION_MS));
        hide_reminder_window(&app_handle);
    });
    Ok(())
}

fn open_size_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let (pet_x, pet_y, pet_size) = app
        .get_webview_window("main")
        .and_then(|window| {
            current_window_geometry(&window)
                .ok()
                .map(|geometry| (geometry.x, geometry.y, geometry.size))
        })
        .unwrap_or((0.0, 0.0, 360.0));
    let width = 420.0;
    let height = 380.0;
    let area = monitor_work_area(app, pet_x + pet_size / 2.0, pet_y + pet_size / 2.0)
        .or_else(|| primary_work_area(app))
        .unwrap_or(WorkArea {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        });
    let x =
        (pet_x + (pet_size - width) / 2.0).clamp(area.x, (area.x + area.width - width).max(area.x));
    let y = (pet_y - height - 12.0).clamp(area.y, (area.y + area.height - height).max(area.y));
    WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("size.html".into()))
        .title("宠物设置")
        .inner_size(width, height)
        .position(x, y)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(true)
        .data_directory(app.state::<AppState>().data_root.join("webview-settings"))
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn send_reset<R: Runtime>(app: &AppHandle<R>, app_state: &AppState, source: &str) {
    {
        let mut state = app_state
            .runtime
            .lock()
            .expect("runtime state mutex poisoned");
        state.phase = "active".to_string();
        state.paused = false;
        state.due_at = 0;
        state.paused_remaining_ms = None;
        state.next_due_at = now_ms() + state.interval_ms;
    }
    hide_reminder_window(app);
    save_runtime_state(app_state);
    send_event(app, "timer-reset", json!({ "source": source }));
    send_state(app, app_state);
}

fn mark_due<R: Runtime>(app: &AppHandle<R>, app_state: &AppState) {
    {
        let mut state = app_state
            .runtime
            .lock()
            .expect("runtime state mutex poisoned");
        if state.phase == "due" {
            return;
        }
        state.phase = "due".to_string();
        state.due_at = now_ms();
        state.paused = false;
    }
    save_runtime_state(app_state);
    send_event(app, "reminder-due", json!({}));
    send_state(app, app_state);
    if let Err(error) = show_reminder_window(app) {
        eprintln!("Could not open reminder window: {error}");
    }
}

fn start_timer(app: AppHandle) {
    thread::spawn(move || loop {
        let app_state = app.state::<AppState>();
        if app_state.quitting.load(Ordering::Relaxed) {
            break;
        }
        let due = {
            let state = app_state
                .runtime
                .lock()
                .expect("runtime state mutex poisoned");
            !state.paused && state.phase == "active" && now_ms() >= state.next_due_at
        };
        if due {
            mark_due(&app, &app_state);
        }
        thread::sleep(Duration::from_millis(500));
    });
}

#[cfg(windows)]
fn start_mouse_hit_test<R: Runtime>(app: AppHandle<R>) {
    thread::spawn(move || loop {
        let app_state = app.state::<AppState>();
        if app_state.quitting.load(Ordering::Relaxed) {
            break;
        }
        let capture = if app_state.dragging.load(Ordering::Relaxed) {
            true
        } else if let Some(window) = app.get_webview_window("main") {
            let insets = *app_state
                .content_insets
                .lock()
                .expect("content insets mutex poisoned");
            cursor_over_content(&window, insets)
        } else {
            false
        };
        let _ = set_native_mouse_ignored(&app, &app_state, !capture);
        thread::sleep(Duration::from_millis(35));
    });
}

#[cfg(not(windows))]
fn start_mouse_hit_test<R: Runtime>(_app: AppHandle<R>) {}

fn create_tray<R: Runtime>(app: &tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItem::with_id(app, "tray:show", "显示宠物", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "tray:settings", "打开设置", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray:quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &settings_item, &quit_item])?;
    TrayIconBuilder::with_id("main")
        .icon(tauri::include_image!("icons/tray-icon.png"))
        .tooltip("Relax Eyes")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.show();
                }
            }
        })
        .build(app)?;
    Ok(())
}

fn create_main_window<R: Runtime>(app: &AppHandle<R>, app_state: &AppState) -> Result<(), String> {
    let scale = app_state
        .runtime
        .lock()
        .expect("runtime state mutex poisoned")
        .display_scale;
    let size = window_size_for_scale(scale);
    let position = initial_position(app, app_state, size);
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Relax Eyes")
        .inner_size(size, size)
        .min_inner_size(MIN_WINDOW_SIZE, MIN_WINDOW_SIZE)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .position(position.x, position.y)
        .data_directory(app_state.data_root.join("webview-main"))
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn configure_main_window<R: Runtime>(
    app: &AppHandle<R>,
    app_state: &AppState,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("main Tauri window is missing")?;
    let scale = app_state
        .runtime
        .lock()
        .expect("runtime state mutex poisoned")
        .display_scale;
    let size = window_size_for_scale(scale);
    let position = initial_position(app, app_state, size);
    set_window_geometry(&window, position, size)?;
    window
        .set_always_on_top(true)
        .map_err(|error| error.to_string())?;
    window
        .set_skip_taskbar(true)
        .map_err(|error| error.to_string())?;
    window
        .set_ignore_cursor_events(true)
        .map_err(|error| error.to_string())?;
    app_state.mouse_ignored.store(true, Ordering::Relaxed);
    window.show().map_err(|error| error.to_string())?;

    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Moved(_) = event {
            let Some(main) = app_handle.get_webview_window("main") else {
                return;
            };
            let Ok(geometry) = current_window_geometry(&main) else {
                return;
            };
            let state = app_handle.state::<AppState>();
            state
                .runtime
                .lock()
                .expect("runtime state mutex poisoned")
                .position = Some(PositionData {
                x: geometry.x,
                y: geometry.y,
            });
            save_runtime_state(&state);
            send_state(&app_handle, &state);
        }
    });
    Ok(())
}

#[tauri::command]
fn get_state(state: State<'_, AppState>) -> Value {
    snapshot(&state)
}

#[tauri::command]
fn get_pet_catalog(state: State<'_, AppState>) -> Vec<PetDefinition> {
    state.pets.clone()
}

#[tauri::command]
fn begin_drag(app: AppHandle, state: State<'_, AppState>) -> Result<PositionData, String> {
    state.dragging.store(true, Ordering::Relaxed);
    if let Err(error) = set_native_mouse_ignored(&app, &state, false) {
        state.dragging.store(false, Ordering::Relaxed);
        return Err(error);
    }
    let window = app
        .get_webview_window("main")
        .ok_or("main window is missing")?;
    let geometry = match current_window_geometry(&window) {
        Ok(geometry) => geometry,
        Err(error) => {
            state.dragging.store(false, Ordering::Relaxed);
            return Err(error);
        }
    };
    Ok(PositionData {
        x: geometry.x,
        y: geometry.y,
    })
}

fn move_window<R: Runtime>(
    app: &AppHandle<R>,
    app_state: &AppState,
    x: f64,
    y: f64,
    persist: bool,
) -> Result<(), String> {
    if !x.is_finite() || !y.is_finite() {
        return Ok(());
    }
    let window = app
        .get_webview_window("main")
        .ok_or("main window is missing")?;
    let geometry = current_window_geometry(&window)?;
    let position = clamp_position(app, app_state, x, y, geometry.size);
    window
        .set_position(Position::Logical(LogicalPosition::new(
            position.x, position.y,
        )))
        .map_err(|error| error.to_string())?;
    if persist {
        app_state
            .runtime
            .lock()
            .expect("runtime state mutex poisoned")
            .position = Some(position);
        save_runtime_state(app_state);
        send_state(app, app_state);
    }
    Ok(())
}

#[tauri::command]
fn move_window_command(
    app: AppHandle,
    state: State<'_, AppState>,
    x: f64,
    y: f64,
) -> Result<(), String> {
    move_window(&app, &state, x, y, false)
}

#[tauri::command]
fn end_drag(app: AppHandle, state: State<'_, AppState>, x: f64, y: f64) -> Result<(), String> {
    let result = move_window(&app, &state, x, y, true);
    state.dragging.store(false, Ordering::Relaxed);
    result
}

#[tauri::command]
fn cancel_drag(state: State<'_, AppState>) {
    state.dragging.store(false, Ordering::Relaxed);
}

#[tauri::command]
fn pet_click(app: AppHandle, state: State<'_, AppState>) {
    let due = state
        .runtime
        .lock()
        .expect("runtime state mutex poisoned")
        .phase
        == "due";
    if due {
        send_reset(&app, &state, "pet-click");
    }
    send_event(&app, "pet-click", json!({}));
}

#[tauri::command]
fn confirm_reminder(app: AppHandle, state: State<'_, AppState>) {
    let due = state
        .runtime
        .lock()
        .expect("runtime state mutex poisoned")
        .phase
        == "due";
    if due {
        send_reset(&app, &state, "reminder-window");
    } else {
        hide_reminder_window(&app);
    }
}

#[tauri::command]
async fn open_size_panel(app: AppHandle) -> Result<(), String> {
    open_size_window(&app)
}

#[tauri::command]
fn set_display_scale(app: AppHandle, state: State<'_, AppState>, value: f64) -> Result<(), String> {
    let next_scale = clamp_display_scale(value);
    let window = app
        .get_webview_window("main")
        .ok_or("main window is missing")?;
    let old_geometry = current_window_geometry(&window)?;
    let next_size = window_size_for_scale(next_scale);
    let area = monitor_work_area(
        &app,
        old_geometry.x + old_geometry.size / 2.0,
        old_geometry.y + old_geometry.size / 2.0,
    )
    .or_else(|| primary_work_area(&app))
    .unwrap_or(WorkArea {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    });
    let insets = *state
        .content_insets
        .lock()
        .expect("content insets mutex poisoned");
    let right_gap = area.x + area.width - (old_geometry.x + old_geometry.size);
    let content_right_gap = area.x + area.width
        - (old_geometry.x + old_geometry.size - inset_pixels(old_geometry.size, insets.right));
    let left_gap = old_geometry.x - area.x;
    let content_left_gap = old_geometry.x + inset_pixels(old_geometry.size, insets.left) - area.x;
    let bottom_gap = area.y + area.height - (old_geometry.y + old_geometry.size);
    let content_bottom_gap = area.y + area.height
        - (old_geometry.y + old_geometry.size - inset_pixels(old_geometry.size, insets.bottom));
    let top_gap = old_geometry.y - area.y;
    let content_top_gap = old_geometry.y + inset_pixels(old_geometry.size, insets.top) - area.y;
    let next_x = if right_gap.abs().min(content_right_gap.abs()) <= EDGE_SNAP_DISTANCE {
        area.x + area.width - next_size + inset_pixels(next_size, insets.right)
    } else if left_gap.abs().min(content_left_gap.abs()) <= EDGE_SNAP_DISTANCE {
        area.x - inset_pixels(next_size, insets.left)
    } else {
        old_geometry.x + (old_geometry.size - next_size) / 2.0
    };
    let next_y = if bottom_gap.abs().min(content_bottom_gap.abs()) <= EDGE_SNAP_DISTANCE {
        area.y + area.height - next_size + inset_pixels(next_size, insets.bottom)
    } else if top_gap.abs().min(content_top_gap.abs()) <= EDGE_SNAP_DISTANCE {
        area.y - inset_pixels(next_size, insets.top)
    } else {
        old_geometry.y + (old_geometry.size - next_size) / 2.0
    };
    let position = clamp_position(&app, &state, next_x, next_y, next_size);
    set_window_geometry(&window, position.clone(), next_size)?;
    {
        let mut runtime = state.runtime.lock().expect("runtime state mutex poisoned");
        runtime.display_scale = next_scale;
        runtime.position = Some(position);
    }
    save_runtime_state(&state);
    send_state(&app, &state);
    Ok(())
}

#[tauri::command]
fn set_reminder_settings(app: AppHandle, state: State<'_, AppState>, settings: Value) {
    let interval_changed = {
        let mut runtime = state.runtime.lock().expect("runtime state mutex poisoned");
        let mut changed = false;
        if let Some(minutes) = settings
            .get("intervalMinutes")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
        {
            let next = clamp_interval((minutes * 60_000.0).round() as i64);
            changed = next != runtime.interval_ms;
            runtime.interval_ms = next;
        }
        if let Some(seconds) = settings
            .get("restSeconds")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
        {
            runtime.rest_duration_ms = clamp_rest_duration((seconds * 1000.0).round() as i64);
        }
        if settings.get("title").is_some() {
            runtime.reminder_title = clean_text(settings.get("title"), DEFAULT_REMINDER_TITLE, 80);
        }
        if settings.get("body").is_some() {
            runtime.reminder_body = clean_text(settings.get("body"), DEFAULT_REMINDER_BODY, 240);
        }
        changed
    };
    if interval_changed {
        send_reset(&app, &state, "interval-change");
    } else {
        save_runtime_state(&state);
        send_state(&app, &state);
    }
}

#[tauri::command]
fn set_content_insets(
    app: AppHandle,
    state: State<'_, AppState>,
    insets: Value,
) -> Result<(), String> {
    let next = ContentInsets {
        left: insets
            .get("left")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .clamp(0.0, MAX_CONTENT_INSET),
        top: insets
            .get("top")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .clamp(0.0, MAX_CONTENT_INSET),
        right: insets
            .get("right")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .clamp(0.0, MAX_CONTENT_INSET),
        bottom: insets
            .get("bottom")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .clamp(0.0, MAX_CONTENT_INSET),
    };
    *state
        .content_insets
        .lock()
        .expect("content insets mutex poisoned") = next;
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let geometry = current_window_geometry(&window)?;
    let position = clamp_position(&app, &state, geometry.x, geometry.y, geometry.size);
    window
        .set_position(Position::Logical(LogicalPosition::new(
            position.x, position.y,
        )))
        .map_err(|error| error.to_string())?;
    state
        .runtime
        .lock()
        .expect("runtime state mutex poisoned")
        .position = Some(position);
    save_runtime_state(&state);
    send_state(&app, &state);
    Ok(())
}

#[tauri::command]
fn set_ignore_mouse(
    app: AppHandle,
    state: State<'_, AppState>,
    ignored: bool,
) -> Result<(), String> {
    if ignored {
        // Tauri cannot forward mouse movement while ignoring the window. The
        // native hit-test thread will enable passthrough after the cursor leaves.
        return Ok(());
    }
    set_native_mouse_ignored(&app, &state, false)
}

#[tauri::command]
fn set_model_actions(
    app: AppHandle,
    state: State<'_, AppState>,
    model_id: String,
    names: Vec<String>,
) {
    if !state.pets.iter().any(|pet| pet.id == model_id) || names.is_empty() {
        return;
    }
    state
        .actions
        .lock()
        .expect("actions mutex poisoned")
        .insert(model_id, names);
    send_state(&app, &state);
}

#[tauri::command]
fn change_model(app: AppHandle, state: State<'_, AppState>, model_id: String) {
    if !state.pets.iter().any(|pet| pet.id == model_id) {
        return;
    }
    let changed = {
        let mut runtime = state.runtime.lock().expect("runtime state mutex poisoned");
        if runtime.model == model_id {
            false
        } else {
            runtime.model = model_id.clone();
            true
        }
    };
    if changed {
        save_runtime_state(&state);
        send_event(&app, "model-change", json!({ "model": model_id }));
        send_state(&app, &state);
    }
}

#[tauri::command]
fn play_animation(app: AppHandle, name: String) {
    send_event(&app, "play-animation", json!({ "name": name }));
}

#[tauri::command]
fn toggle_pause(app: AppHandle, state: State<'_, AppState>) {
    {
        let mut runtime = state.runtime.lock().expect("runtime state mutex poisoned");
        if runtime.phase == "due" {
            return;
        }
        if runtime.paused {
            runtime.paused = false;
            runtime.next_due_at = now_ms()
                + runtime
                    .paused_remaining_ms
                    .take()
                    .unwrap_or(runtime.interval_ms)
                    .max(MIN_INTERVAL_MS);
        } else {
            runtime.paused_remaining_ms =
                Some((runtime.next_due_at - now_ms()).max(MIN_INTERVAL_MS));
            runtime.paused = true;
        }
    }
    save_runtime_state(&state);
    send_state(&app, &state);
}

#[tauri::command]
fn reset_timer(app: AppHandle, state: State<'_, AppState>, source: String) {
    send_reset(&app, &state, &source);
}

#[tauri::command]
fn quit_app(app: AppHandle, state: State<'_, AppState>) {
    state.quitting.store(true, Ordering::Relaxed);
    save_runtime_state(&state);
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if webview2_runtime_version().is_none() {
        let message = "未检测到 Microsoft Edge WebView2 Runtime。\n请先由系统管理员安装 WebView2 Runtime，再启动本程序。\n本程序不会自动安装或修改系统设置。";
        show_webview2_error(message);
        eprintln!("{message}");
        return;
    }
    let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or(Path::new("."))
        .to_path_buf();
    let data_root = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or(project_root)
        .join("data");
    let pets = load_pets();
    let state_path = data_root.join("state.json");
    let runtime = load_runtime_state(&state_path, &pets);
    let app_state = AppState {
        runtime: Mutex::new(runtime),
        actions: Mutex::new(HashMap::new()),
        content_insets: Mutex::new(ContentInsets::default()),
        dragging: AtomicBool::new(false),
        mouse_ignored: AtomicBool::new(true),
        data_root,
        pets,
        quitting: AtomicBool::new(false),
    };

    tauri::Builder::default()
        .manage(app_state)
        .setup(|app| {
            let state = app.state::<AppState>();
            if std::env::args().any(|arg| arg == "--debug-timer") {
                state
                    .runtime
                    .lock()
                    .expect("runtime state mutex poisoned")
                    .interval_ms = DEBUG_INTERVAL_MS;
                send_reset(app.handle(), &state, "debug");
            }
            create_main_window(app.handle(), &state)?;
            configure_main_window(app.handle(), &state)?;
            create_tray(app)?;
            start_timer(app.handle().clone());
            start_mouse_hit_test(app.handle().clone());
            send_state(app.handle(), &state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            get_pet_catalog,
            begin_drag,
            move_window_command,
            end_drag,
            cancel_drag,
            pet_click,
            confirm_reminder,
            open_size_panel,
            set_display_scale,
            set_reminder_settings,
            set_content_insets,
            set_ignore_mouse,
            set_model_actions,
            change_model,
            play_animation,
            toggle_pause,
            reset_timer,
            quit_app,
        ])
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray:show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                }
            }
            "tray:settings" => {
                let app_handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = open_size_window(&app_handle);
                });
            }
            "tray:quit" => {
                if let Some(state) = app.try_state::<AppState>() {
                    state.quitting.store(true, Ordering::Relaxed);
                    save_runtime_state(&state);
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    if let Some(state) = window.app_handle().try_state::<AppState>() {
                        if !state.quitting.load(Ordering::Relaxed) {
                            api.prevent_close();
                            let _ = window.hide();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
