use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{ErrorKind, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use std::{ffi::OsStr, os::windows::ffi::OsStrExt, process::Command};

#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};

use chrono::{Datelike, Duration as ChronoDuration, Local, NaiveTime, TimeZone, Weekday};
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
const DEFAULT_FACING: &str = "right";
const MIN_DISPLAY_SCALE: f64 = 0.15;
const MAX_DISPLAY_SCALE: f64 = 1.0;
const MIN_REST_DURATION_MS: i64 = 5 * 1000;
const MAX_REST_DURATION_MS: i64 = 10 * 60 * 1000;
const DEFAULT_REST_DURATION_MS: i64 = 20 * 1000;
const DEFAULT_REMINDER_TITLE: &str = "该放松一下眼睛了";
const DEFAULT_REMINDER_BODY: &str = "看向远处 {seconds} 秒，或者点击宠物确认已经休息。";
const DEFAULT_WEEKLY_REPORT_TITLE: &str = "该写周报了";
const DEFAULT_WEEKLY_REPORT_BODY: &str = "花几分钟回顾本周完成的工作和下周计划。";
const DEFAULT_WEEKLY_REPORT_WEEKDAY: u8 = 5;
const DEFAULT_WEEKLY_REPORT_TIME: &str = "15:00";
const DEFAULT_SOUND_VOLUME: f64 = 0.65;
const MIN_CODEX_BUBBLE_SCALE: f64 = 0.7;
const MAX_CODEX_BUBBLE_SCALE: f64 = 1.4;
const DEFAULT_CODEX_BUBBLE_SCALE: f64 = 1.0;
const DEFAULT_REMINDER_ACCENT: &str = "#ff9c60";
const DEFAULT_WEEKLY_REPORT_ACCENT: &str = "#e5484d";
const DEFAULT_CODEX_COMPLETED_ACCENT: &str = "#45d483";
const DEFAULT_CODEX_WAITING_ACCENT: &str = "#ffd166";
const DEFAULT_CODEX_FAILED_ACCENT: &str = "#ff6b6b";
const DEFAULT_CODEX_STARTED_ACCENT: &str = "#71b7ff";
const REMINDER_WINDOW_WIDTH: f64 = 440.0;
const REMINDER_WINDOW_HEIGHT: f64 = 210.0;
const REMINDER_WINDOW_DURATION_MS: u64 = 15 * 1000;
const EDGE_SNAP_DISTANCE: f64 = 48.0;
const MAX_CONTENT_INSET: f64 = 0.45;
const WEBVIEW2_CLIENT_ID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
const CODEX_PROTOCOL: &str = "codex-pet/v1";
const CODEX_ENDPOINT_FILE: &str = "codex-pet-endpoint.json";
const CODEX_QUEUE_FILE: &str = "codex-pet-queue.jsonl";
const CODEX_AGENT_LOG_FILE: &str = "codex-pet-agent.log";
const CODEX_TOKEN_HEADER: &str = "x-codex-pet-token";
const CODEX_MAX_HEADER_BYTES: usize = 16 * 1024;
const CODEX_MAX_BODY_BYTES: usize = 64 * 1024;
const CODEX_MAX_QUEUE_LENGTH: usize = 100;
const CODEX_MAX_SEEN_IDS: usize = 2048;
const CODEX_MAX_TEXT_LENGTH: usize = 2000;
const CODEX_MAX_DETAILS_DEPTH: usize = 4;
const CODEX_MAX_TRACKED_TURNS: usize = 256;
const CODEX_TURN_TTL_MS: i64 = 30 * 60 * 1000;
const CODEX_QUEUE_COMPACT_THRESHOLD: usize = 512;
const WORK_AREA_CACHE_TTL_MS: i64 = 500;

static STATE_WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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

#[cfg(windows)]
fn acquire_single_instance() -> bool {
    use windows_sys::Win32::{
        Foundation::{GetLastError, ERROR_ALREADY_EXISTS},
        System::Threading::CreateMutexW,
    };

    let name: Vec<u16> = OsStr::new("Local\\RelaxEyesDesktopSingleInstance")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle.is_null() {
        return false;
    }
    unsafe { GetLastError() != ERROR_ALREADY_EXISTS }
}

#[cfg(not(windows))]
fn acquire_single_instance() -> bool {
    true
}

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
    #[serde(default)]
    visible_pets: Vec<String>,
    #[serde(default = "default_facing")]
    facing: String,
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
    #[serde(default = "default_codex_enabled")]
    codex_enabled: bool,
    #[serde(default = "default_eye_break_enabled")]
    eye_break_enabled: bool,
    #[serde(default = "default_weekly_report_enabled")]
    weekly_report_enabled: bool,
    #[serde(default = "default_weekly_report_weekday")]
    weekly_report_weekday: u8,
    #[serde(default = "default_weekly_report_time")]
    weekly_report_time: String,
    #[serde(default)]
    weekly_report_next_due_at: i64,
    #[serde(default)]
    weekly_report_due_at: i64,
    #[serde(default = "default_weekly_report_title")]
    weekly_report_title: String,
    #[serde(default = "default_weekly_report_body")]
    weekly_report_body: String,
    #[serde(default = "default_sound_volume")]
    sound_volume: f64,
    #[serde(default = "default_codex_bubble_scale")]
    codex_bubble_scale: f64,
    #[serde(default = "default_reminder_accent")]
    reminder_accent: String,
    #[serde(default = "default_weekly_report_accent")]
    weekly_report_accent: String,
    #[serde(default = "default_codex_completed_accent")]
    codex_completed_accent: String,
    #[serde(default = "default_codex_waiting_accent")]
    codex_waiting_accent: String,
    #[serde(default = "default_codex_failed_accent")]
    codex_failed_accent: String,
    #[serde(default = "default_codex_started_accent")]
    codex_started_accent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    paused_remaining_ms: Option<i64>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        let now = now_ms();
        Self {
            model: "yao".to_string(),
            visible_pets: Vec::new(),
            facing: DEFAULT_FACING.to_string(),
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
            codex_enabled: true,
            eye_break_enabled: true,
            weekly_report_enabled: true,
            weekly_report_weekday: DEFAULT_WEEKLY_REPORT_WEEKDAY,
            weekly_report_time: DEFAULT_WEEKLY_REPORT_TIME.to_string(),
            weekly_report_next_due_at: next_weekly_due_at(
                now,
                DEFAULT_WEEKLY_REPORT_WEEKDAY,
                DEFAULT_WEEKLY_REPORT_TIME,
            ),
            weekly_report_due_at: 0,
            weekly_report_title: DEFAULT_WEEKLY_REPORT_TITLE.to_string(),
            weekly_report_body: DEFAULT_WEEKLY_REPORT_BODY.to_string(),
            sound_volume: DEFAULT_SOUND_VOLUME,
            codex_bubble_scale: DEFAULT_CODEX_BUBBLE_SCALE,
            reminder_accent: DEFAULT_REMINDER_ACCENT.to_string(),
            weekly_report_accent: DEFAULT_WEEKLY_REPORT_ACCENT.to_string(),
            codex_completed_accent: DEFAULT_CODEX_COMPLETED_ACCENT.to_string(),
            codex_waiting_accent: DEFAULT_CODEX_WAITING_ACCENT.to_string(),
            codex_failed_accent: DEFAULT_CODEX_FAILED_ACCENT.to_string(),
            codex_started_accent: DEFAULT_CODEX_STARTED_ACCENT.to_string(),
            paused_remaining_ms: None,
        }
    }
}

fn default_codex_enabled() -> bool {
    true
}

fn default_facing() -> String {
    DEFAULT_FACING.to_string()
}

fn default_eye_break_enabled() -> bool {
    true
}

fn default_weekly_report_enabled() -> bool {
    true
}

fn default_weekly_report_weekday() -> u8 {
    DEFAULT_WEEKLY_REPORT_WEEKDAY
}

fn default_weekly_report_time() -> String {
    DEFAULT_WEEKLY_REPORT_TIME.to_string()
}

fn default_weekly_report_title() -> String {
    DEFAULT_WEEKLY_REPORT_TITLE.to_string()
}

fn default_weekly_report_body() -> String {
    DEFAULT_WEEKLY_REPORT_BODY.to_string()
}

fn default_sound_volume() -> f64 {
    DEFAULT_SOUND_VOLUME
}

fn default_codex_bubble_scale() -> f64 {
    DEFAULT_CODEX_BUBBLE_SCALE
}

fn default_reminder_accent() -> String {
    DEFAULT_REMINDER_ACCENT.to_string()
}

fn default_weekly_report_accent() -> String {
    DEFAULT_WEEKLY_REPORT_ACCENT.to_string()
}

fn default_codex_completed_accent() -> String {
    DEFAULT_CODEX_COMPLETED_ACCENT.to_string()
}

fn default_codex_waiting_accent() -> String {
    DEFAULT_CODEX_WAITING_ACCENT.to_string()
}

fn default_codex_failed_accent() -> String {
    DEFAULT_CODEX_FAILED_ACCENT.to_string()
}

fn default_codex_started_accent() -> String {
    DEFAULT_CODEX_STARTED_ACCENT.to_string()
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetDefinition {
    id: String,
    label: String,
    #[serde(default)]
    engine: String,
    #[serde(default)]
    base_animations: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    preview: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct PetPackActions {
    #[serde(default)]
    raw: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct PetPackPreview {
    #[serde(rename = "static", default)]
    static_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct PetPackDefinition {
    id: String,
    name: String,
    engine: String,
    #[serde(default)]
    actions: PetPackActions,
    #[serde(default)]
    preview: PetPackPreview,
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

struct CodexQueue {
    path: PathBuf,
    pending: Vec<Value>,
    seen: HashSet<String>,
    seen_order: Vec<String>,
    record_count: usize,
    last_compaction_count: usize,
}

impl CodexQueue {
    fn load(data_root: &Path) -> Self {
        let path = data_root.join(CODEX_QUEUE_FILE);
        let mut queue = Self {
            path,
            pending: Vec::new(),
            seen: HashSet::new(),
            seen_order: Vec::new(),
            record_count: 0,
            last_compaction_count: 0,
        };
        let Ok(text) = fs::read_to_string(&queue.path) else {
            return queue;
        };
        for line in text.lines() {
            queue.record_count += 1;
            let Ok(record) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            match record.get("op").and_then(Value::as_str) {
                Some("seen") => {
                    if let Some(event_id) = record.get("eventId").and_then(Value::as_str) {
                        queue.remember(event_id.to_string());
                    }
                }
                Some("enqueue") => {
                    let Some(event) = record.get("event").filter(|value| value.is_object()) else {
                        continue;
                    };
                    let Some(event_id) = event.get("eventId").and_then(Value::as_str) else {
                        continue;
                    };
                    queue.remember(event_id.to_string());
                    queue.pending.retain(|item| {
                        item.get("eventId").and_then(Value::as_str) != Some(event_id)
                    });
                    queue.pending.push(event.clone());
                }
                Some("ack") => {
                    if let Some(event_id) = record.get("eventId").and_then(Value::as_str) {
                        queue.pending.retain(|item| {
                            item.get("eventId").and_then(Value::as_str) != Some(event_id)
                        });
                    }
                }
                _ => {}
            }
        }
        queue.last_compaction_count = if queue.record_count >= CODEX_QUEUE_COMPACT_THRESHOLD {
            0
        } else {
            queue.record_count
        };
        let _ = queue.compact_if_needed();
        queue
    }

    fn remember(&mut self, event_id: String) {
        if !self.seen.insert(event_id.clone()) {
            return;
        }
        self.seen_order.push(event_id);
        while self.seen_order.len() > CODEX_MAX_SEEN_IDS {
            let stale = self.seen_order.remove(0);
            self.seen.remove(&stale);
        }
    }

    fn append(&self, record: Value) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|error| error.to_string())?;
        let bytes = serde_json::to_vec(&record).map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())
    }

    fn enqueue(&mut self, event: Value) -> Result<bool, String> {
        let Some(event_id) = event.get("eventId").and_then(Value::as_str) else {
            return Err("Codex event is missing eventId".to_string());
        };
        if self.seen.contains(event_id) {
            return Ok(false);
        }
        if self.pending.len() >= CODEX_MAX_QUEUE_LENGTH {
            return Err("Codex notification queue is full".to_string());
        }
        self.append(json!({ "op": "enqueue", "event": event.clone() }))?;
        self.record_count += 1;
        self.remember(event_id.to_string());
        self.pending.push(event);
        let _ = self.compact_if_needed();
        Ok(true)
    }

    fn pending_event(&self, event_id: &str) -> Option<Value> {
        self.pending
            .iter()
            .find(|item| item.get("eventId").and_then(Value::as_str) == Some(event_id))
            .cloned()
    }

    fn acknowledge(&mut self, event_id: &str) -> Result<bool, String> {
        if !self
            .pending
            .iter()
            .any(|item| item.get("eventId").and_then(Value::as_str) == Some(event_id))
        {
            return Ok(false);
        }
        self.append(json!({ "op": "ack", "eventId": event_id }))?;
        self.record_count += 1;
        self.pending
            .retain(|item| item.get("eventId").and_then(Value::as_str) != Some(event_id));
        let _ = self.compact_if_needed();
        Ok(true)
    }

    fn compact_if_needed(&mut self) -> Result<(), String> {
        if self.record_count < self.last_compaction_count + CODEX_QUEUE_COMPACT_THRESHOLD {
            return Ok(());
        }
        let mut records = Vec::with_capacity(self.seen_order.len() + self.pending.len());
        records.extend(
            self.seen_order
                .iter()
                .map(|event_id| json!({ "op": "seen", "eventId": event_id })),
        );
        records.extend(
            self.pending
                .iter()
                .cloned()
                .map(|event| json!({ "op": "enqueue", "event": event })),
        );
        let mut bytes = Vec::new();
        for record in records {
            serde_json::to_writer(&mut bytes, &record).map_err(|error| error.to_string())?;
            bytes.push(b'\n');
        }
        write_file_atomically(&self.path, &bytes).map_err(|error| error.to_string())?;
        self.record_count = self.seen_order.len() + self.pending.len();
        self.last_compaction_count = self.record_count;
        Ok(())
    }
}

#[derive(Clone, Debug)]
struct CodexTurnState {
    last_seen_at: i64,
    failure_reason: Option<String>,
}

#[derive(Default)]
struct CodexTurnLedger {
    turns: HashMap<String, CodexTurnState>,
}

impl CodexTurnLedger {
    fn prune(&mut self) {
        let cutoff = now_ms().saturating_sub(CODEX_TURN_TTL_MS);
        self.turns
            .retain(|_, state| state.last_seen_at >= cutoff);
        while self.turns.len() > CODEX_MAX_TRACKED_TURNS {
            let Some(oldest_key) = self
                .turns
                .iter()
                .min_by_key(|(_, state)| state.last_seen_at)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.turns.remove(&oldest_key);
        }
    }

    fn key(event: &Value) -> Option<String> {
        let session_id = event.get("sessionId").and_then(Value::as_str)?;
        let turn_id = event.get("turnId").and_then(Value::as_str)?;
        if session_id.is_empty() || turn_id.is_empty() {
            return None;
        }
        Some(format!("{session_id}\u{0}{turn_id}"))
    }

    fn observe_failure(&mut self, event: &Value) -> bool {
        self.prune();
        let Some(key) = Self::key(event) else {
            return false;
        };
        let state = self.turns.entry(key).or_insert_with(|| CodexTurnState {
            last_seen_at: now_ms(),
            failure_reason: None,
        });
        state.last_seen_at = now_ms();
        state.failure_reason = event
            .get("failureReason")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| state.failure_reason.clone());
        true
    }

    fn finish(&mut self, event: &Value) -> Option<CodexTurnState> {
        self.prune();
        Self::key(event).and_then(|key| self.turns.remove(&key))
    }
}

struct AppState {
    runtime: Mutex<RuntimeState>,
    actions: Mutex<HashMap<String, Vec<String>>>,
    codex_queue: Mutex<CodexQueue>,
    codex_turns: Mutex<CodexTurnLedger>,
    content_insets: Mutex<ContentInsets>,
    position_revision: AtomicU64,
    persisted_position_revision: AtomicU64,
    work_area_cache: Mutex<Option<CachedWorkArea>>,
    dragging: AtomicBool,
    mouse_ignored: AtomicBool,
    data_root: PathBuf,
    pets: Vec<PetDefinition>,
    quitting: AtomicBool,
    reminder_generation: AtomicU64,
}

#[derive(Clone, Copy, Debug)]
struct WorkArea {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Copy, Debug)]
struct CachedWorkArea {
    area: WorkArea,
    monitor_bounds: WorkArea,
    expires_at: i64,
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

fn clamp_weekly_report_weekday(value: i64) -> u8 {
    value.clamp(1, 7) as u8
}

fn clamp_sound_volume(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        DEFAULT_SOUND_VOLUME
    }
}

fn clamp_codex_bubble_scale(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(MIN_CODEX_BUBBLE_SCALE, MAX_CODEX_BUBBLE_SCALE)
    } else {
        DEFAULT_CODEX_BUBBLE_SCALE
    }
}

fn parse_weekly_report_time(value: &str) -> Option<NaiveTime> {
    let mut parts = value.trim().split(':');
    let hour = parts.next()?.parse::<u32>().ok()?;
    let minute = parts.next()?.parse::<u32>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    NaiveTime::from_hms_opt(hour, minute, 0)
}

fn clean_weekly_report_time(value: Option<&Value>, fallback: &str) -> String {
    value
        .and_then(Value::as_str)
        .and_then(|value| parse_weekly_report_time(value).map(|_| value.trim().to_string()))
        .unwrap_or_else(|| fallback.to_string())
}

fn clean_hex_color(value: Option<&Value>, fallback: &str) -> String {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| {
            value.len() == 7
                && value.starts_with('#')
                && value[1..]
                    .chars()
                    .all(|character| character.is_ascii_hexdigit())
        })
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_else(|| fallback.to_string())
}

fn weekly_report_weekday(value: u8) -> Weekday {
    match value {
        1 => Weekday::Mon,
        2 => Weekday::Tue,
        3 => Weekday::Wed,
        4 => Weekday::Thu,
        5 => Weekday::Fri,
        6 => Weekday::Sat,
        _ => Weekday::Sun,
    }
}

fn next_weekly_due_at(now: i64, weekday: u8, time: &str) -> i64 {
    let current = Local
        .timestamp_millis_opt(now)
        .single()
        .unwrap_or_else(Local::now);
    let target_weekday = weekly_report_weekday(weekday);
    let target_time = parse_weekly_report_time(time)
        .or_else(|| parse_weekly_report_time(DEFAULT_WEEKLY_REPORT_TIME))
        .unwrap_or(NaiveTime::MIN);
    let current_weekday = current.weekday().num_days_from_monday() as i64;
    let target_day = target_weekday.num_days_from_monday() as i64;
    let mut days_ahead = (target_day - current_weekday + 7) % 7;
    if days_ahead == 0 && current.time() >= target_time {
        days_ahead = 7;
    }
    let date = current.date_naive() + ChronoDuration::days(days_ahead);
    let naive = date.and_time(target_time);
    Local
        .from_local_datetime(&naive)
        .single()
        .or_else(|| Local.from_local_datetime(&naive).earliest())
        .map(|value| value.timestamp_millis())
        .unwrap_or_else(|| now.saturating_add(7 * 24 * 60 * 60 * 1000))
}

fn clean_text(value: Option<&Value>, fallback: &str, maximum_length: usize) -> String {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(maximum_length).collect())
        .unwrap_or_else(|| fallback.to_string())
}

fn codex_value<'a>(
    object: &'a serde_json::Map<String, Value>,
    snake_name: &str,
    camel_name: &str,
) -> Option<&'a Value> {
    object.get(snake_name).or_else(|| object.get(camel_name))
}

fn required_codex_text(
    object: &serde_json::Map<String, Value>,
    snake_name: &str,
    camel_name: &str,
    maximum_length: usize,
) -> Result<String, String> {
    let value = codex_value(object, snake_name, camel_name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| redact_sensitive_text(value, maximum_length));
    value.ok_or_else(|| format!("Codex event is missing {snake_name}"))
}

fn optional_codex_text(
    object: &serde_json::Map<String, Value>,
    snake_name: &str,
    camel_name: &str,
    maximum_length: usize,
) -> Option<String> {
    codex_value(object, snake_name, camel_name)
        .and_then(Value::as_str)
        .map(|value| redact_sensitive_text(value, maximum_length))
        .filter(|value| !value.is_empty())
}

fn is_sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "token",
        "secret",
        "password",
        "api_key",
        "apikey",
        "authorization",
        "access_key",
        "private_key",
        "command",
        "cmd",
        "args",
        "arguments",
        "env",
        "environment",
        "path",
        "cwd",
        "workdir",
        "working_directory",
    ]
    .iter()
    .any(|marker| key.contains(marker))
}

fn redact_sensitive_text(value: &str, maximum_length: usize) -> String {
    let mut output = value.trim().to_string();
    for marker in [
        "token=",
        "api_key=",
        "apikey=",
        "secret=",
        "password=",
        "authorization:",
    ] {
        let lower = output.to_ascii_lowercase();
        let Some(start) = lower.find(marker) else {
            continue;
        };
        let value_start = start + marker.len();
        let value_end = output[value_start..]
            .find(|character: char| character.is_whitespace())
            .map(|offset| value_start + offset)
            .unwrap_or(output.len());
        output.replace_range(value_start..value_end, "[REDACTED]");
    }
    output.chars().take(maximum_length).collect()
}

fn sanitize_codex_value(value: &Value, depth: usize) -> Value {
    if depth >= CODEX_MAX_DETAILS_DEPTH {
        return Value::String("[TRUNCATED]".to_string());
    }
    match value {
        Value::Object(object) => {
            let redacts_value = matches!(
                object.get("type").and_then(Value::as_str),
                Some("command" | "path" | "environment" | "env" | "arguments")
            );
            let mut sanitized = serde_json::Map::new();
            for (key, item) in object {
                if is_sensitive_key(key) || (key == "value" && redacts_value) {
                    sanitized.insert(key.clone(), Value::String("[REDACTED]".to_string()));
                } else {
                    sanitized.insert(key.clone(), sanitize_codex_value(item, depth + 1));
                }
            }
            Value::Object(sanitized)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .take(24)
                .map(|item| sanitize_codex_value(item, depth + 1))
                .collect(),
        ),
        Value::String(text) => Value::String(redact_sensitive_text(text, CODEX_MAX_TEXT_LENGTH)),
        _ => value.clone(),
    }
}

fn normalize_codex_event(value: Value) -> Result<Value, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Codex event must be a JSON object".to_string())?;
    let protocol = required_codex_text(object, "protocol", "protocol", 40)?;
    if protocol != CODEX_PROTOCOL {
        return Err(format!("Unsupported Codex protocol: {protocol}"));
    }
    let event_id = required_codex_text(object, "event_id", "eventId", 160)?;
    let event_type = required_codex_text(object, "event_type", "eventType", 80)?;
    let status = required_codex_text(object, "status", "status", 80)?;
    let is_internal = matches!(
        event_type.as_str(),
        "tool_failure_candidate" | "turn_stop"
    );
    let valid_status = matches!(
        (event_type.as_str(), status.as_str()),
        ("permission_request", "waiting_confirmation")
            | ("task_started", "started")
            | ("task_completed", "completed")
            | ("task_failed", "failed")
            | ("tool_failure_candidate", "observed")
            | ("turn_stop", "observed")
    );
    if !valid_status {
        return Err("Codex event type and status do not match".to_string());
    }
    let visibility = optional_codex_text(object, "visibility", "visibility", 40);
    if is_internal && visibility.as_deref() != Some("internal") {
        return Err("Internal Codex events must set visibility to internal".to_string());
    }
    let session_id = if is_internal {
        Some(required_codex_text(object, "session_id", "sessionId", 160)?)
    } else {
        optional_codex_text(object, "session_id", "sessionId", 160)
    };
    let turn_id = if is_internal {
        Some(required_codex_text(object, "turn_id", "turnId", 160)?)
    } else {
        optional_codex_text(object, "turn_id", "turnId", 160)
    };
    let terminal_outcome = optional_codex_text(
        object,
        "terminal_outcome",
        "terminalOutcome",
        40,
    );
    if event_type == "turn_stop"
        && !matches!(
            terminal_outcome.as_deref(),
            Some("completed" | "failed_candidate" | "manual_required" | "transient")
        )
    {
        return Err("Codex turn_stop has an invalid terminal outcome".to_string());
    }
    let title = required_codex_text(object, "title", "title", 120)?;
    let summary = required_codex_text(object, "summary", "summary", CODEX_MAX_TEXT_LENGTH)?;
    let source = required_codex_text(object, "source", "source", 80)?;
    let project = required_codex_text(object, "project", "project", 160)?;
    let created_at = required_codex_text(object, "created_at", "createdAt", 80)?;
    let details = codex_value(object, "details", "details")
        .ok_or_else(|| "Codex event is missing details".to_string())?;
    if !details.is_array() {
        return Err("Codex event details must be an array".to_string());
    }
    let details = sanitize_codex_value(details, 0);
    let (accent_color, requires_confirmation) = match status.as_str() {
        "completed" => ("#45d483", false),
        "waiting_confirmation" => ("#ffd166", true),
        "failed" => ("#ff6b6b", false),
        _ => ("#71b7ff", false),
    };

    let failure_reason = optional_codex_text(object, "failure_reason", "failureReason", 240);
    let agent_id = optional_codex_text(object, "agent_id", "agentId", 120);
    let mut normalized = json!({
        "protocol": CODEX_PROTOCOL,
        "eventId": event_id,
        "eventType": event_type,
        "status": status,
        "title": title,
        "summary": summary.clone(),
        "body": summary,
        "details": details,
        "source": source,
        "project": project,
        "createdAt": created_at,
        "notificationType": "codex",
        "accentColor": accent_color,
        "requiresConfirmation": requires_confirmation,
    });
    if let Value::Object(normalized) = &mut normalized {
        if let Some(visibility) = visibility {
            normalized.insert("visibility".to_string(), Value::String(visibility));
        }
        if let Some(session_id) = session_id {
            normalized.insert("sessionId".to_string(), Value::String(session_id));
        }
        if let Some(turn_id) = turn_id {
            normalized.insert("turnId".to_string(), Value::String(turn_id));
        }
        if let Some(agent_id) = agent_id {
            normalized.insert("agentId".to_string(), Value::String(agent_id));
        }
        if let Some(terminal_outcome) = terminal_outcome {
            normalized.insert(
                "terminalOutcome".to_string(),
                Value::String(terminal_outcome),
            );
        }
        if let Some(failure_reason) = failure_reason {
            normalized.insert(
                "failureReason".to_string(),
                Value::String(failure_reason),
            );
        }
    }
    Ok(normalized)
}

struct CodexHttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn read_codex_http_request(stream: &mut TcpStream) -> Result<CodexHttpRequest, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;
    let mut buffer = Vec::with_capacity(4096);
    let header_end = loop {
        if let Some(end) = header_end(&buffer) {
            break end;
        }
        if buffer.len() > CODEX_MAX_HEADER_BYTES {
            return Err("HTTP headers are too large".to_string());
        }
        let mut chunk = [0_u8; 2048];
        let read = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("HTTP request ended before headers were complete".to_string());
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let header_text = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = header_text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "HTTP request line is missing".to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| "HTTP method is missing".to_string())?
        .to_string();
    let path = request_parts
        .next()
        .ok_or_else(|| "HTTP path is missing".to_string())?
        .split('?')
        .next()
        .unwrap_or_default()
        .to_string();
    let mut headers = HashMap::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
    }
    let content_length = headers
        .get("content-length")
        .map(|value| value.parse::<usize>().map_err(|error| error.to_string()))
        .transpose()?
        .unwrap_or(0);
    if content_length > CODEX_MAX_BODY_BYTES {
        return Err("HTTP body is too large".to_string());
    }
    let body_start = header_end + 4;
    while buffer.len() < body_start + content_length {
        let mut chunk = [0_u8; 4096];
        let read = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("HTTP request ended before the body was complete".to_string());
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    Ok(CodexHttpRequest {
        method,
        path,
        headers,
        body: buffer[body_start..body_start + content_length].to_vec(),
    })
}

fn write_codex_json_response(
    stream: &mut TcpStream,
    status: &str,
    payload: Value,
) -> Result<(), String> {
    let body = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(header.as_bytes())
        .and_then(|_| stream.write_all(&body))
        .map_err(|error| error.to_string())
}

fn codex_token() -> String {
    let mut value = now_ms() as u64
        ^ ((std::process::id() as u64) << 32)
        ^ (&CODEX_PROTOCOL as *const &str as usize as u64);
    let mut token = String::with_capacity(64);
    for _ in 0..4 {
        value ^= value << 13;
        value ^= value >> 7;
        value ^= value << 17;
        token.push_str(&format!("{value:016x}"));
    }
    token
}

fn write_codex_endpoint(data_root: &Path, port: u16, token: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(data_root).map_err(|error| error.to_string())?;
    let path = data_root.join(CODEX_ENDPOINT_FILE);
    let endpoint = json!({
        "protocol": CODEX_PROTOCOL,
        "host": "127.0.0.1",
        "port": port,
        "token": token,
        "pid": std::process::id(),
        "startedAt": now_ms(),
    });
    fs::write(
        &path,
        serde_json::to_vec_pretty(&endpoint).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(path)
}

fn clear_codex_endpoint(data_root: &Path) {
    let _ = fs::remove_file(data_root.join(CODEX_ENDPOINT_FILE));
}

fn codex_agent_log(data_root: &Path, message: &str) {
    if fs::create_dir_all(data_root).is_err() {
        return;
    }
    let path = data_root.join(CODEX_AGENT_LOG_FILE);
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let _ = writeln!(file, "{} {message}", now_ms());
}

fn codex_terminal_event(
    event: &Value,
    turn_state: Option<&CodexTurnState>,
    failed: bool,
) -> Value {
    let mut visible = event.clone();
    let event_id = event
        .get("eventId")
        .and_then(Value::as_str)
        .unwrap_or("codex-terminal");
    let reason = event
        .get("failureReason")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .or_else(|| turn_state.and_then(|state| state.failure_reason.as_deref()));
    if let Value::Object(object) = &mut visible {
        object.insert(
            "eventId".to_string(),
            Value::String(format!("{event_id}:terminal")),
        );
        object.insert(
            "eventType".to_string(),
            Value::String(if failed {
                "task_failed".to_string()
            } else {
                "task_completed".to_string()
            }),
        );
        object.insert(
            "status".to_string(),
            Value::String(if failed {
                "failed".to_string()
            } else {
                "completed".to_string()
            }),
        );
        object.insert(
            "title".to_string(),
            Value::String(if failed {
                "Codex 工作失败".to_string()
            } else {
                "Codex 工作完成".to_string()
            }),
        );
        let summary = if failed {
            reason
                .map(|reason| format!("Codex 当前回合需要手动处理：{reason}"))
                .unwrap_or_else(|| "Codex 当前回合未能完成，需要手动处理。".to_string())
        } else {
            object
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or("Codex 已结束当前工作回合。")
                .to_string()
        };
        object.insert("summary".to_string(), Value::String(summary.clone()));
        object.insert("body".to_string(), Value::String(summary));
        object.insert(
            "accentColor".to_string(),
            Value::String(if failed {
                "#ff6b6b".to_string()
            } else {
                "#45d483".to_string()
            }),
        );
        object.insert("requiresConfirmation".to_string(), Value::Bool(false));
        object.remove("visibility");
        object.remove("terminalOutcome");
    }
    visible
}

fn is_failed_terminal_outcome(outcome: &str) -> bool {
    matches!(outcome, "failed_candidate" | "manual_required")
}

fn enqueue_codex_event<R: Runtime>(
    app: &AppHandle<R>,
    app_state: &AppState,
    event: Value,
) -> Result<Value, String> {
    let event_id = event
        .get("eventId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Codex event is missing eventId".to_string())?
        .to_string();
    let (accepted, pending_duplicate) = {
        let mut queue = app_state
            .codex_queue
            .lock()
            .expect("Codex queue mutex poisoned");
        let accepted = queue.enqueue(event.clone())?;
        let pending_duplicate = if accepted {
            None
        } else {
            queue.pending_event(&event_id)
        };
        (accepted, pending_duplicate)
    };
    if !accepted {
        if let Some(pending_event) = pending_duplicate {
            // A retry can arrive after the first WebView event was missed. Re-emit
            // pending duplicates so the renderer can recover from that race.
            send_event(
                app,
                "codex-notification",
                json!({ "event": pending_event, "replayed": true }),
            );
            send_state(app, app_state);
        }
        return Ok(json!({
            "ok": true,
            "accepted": false,
            "duplicate": true,
            "eventId": event_id,
        }));
    }
    send_event(
        app,
        "codex-notification",
        json!({ "event": event, "replayed": false }),
    );
    send_state(app, app_state);
    refresh_reminder_window(app, app_state);
    Ok(json!({
        "ok": true,
        "accepted": true,
        "duplicate": false,
        "eventId": event_id,
    }))
}

fn process_internal_codex_event<R: Runtime>(
    app: &AppHandle<R>,
    app_state: &AppState,
    event: Value,
) -> Result<Value, String> {
    let event_id = event
        .get("eventId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    match event.get("eventType").and_then(Value::as_str) {
        Some("tool_failure_candidate") => {
            let accepted = app_state
                .codex_turns
                .lock()
                .expect("Codex turn ledger mutex poisoned")
                .observe_failure(&event);
            Ok(json!({
                "ok": true,
                "accepted": accepted,
                "internal": true,
                "eventId": event_id,
            }))
        }
        Some("turn_stop") => {
            let outcome = event
                .get("terminalOutcome")
                .and_then(Value::as_str)
                .unwrap_or("completed");
            let turn_state = app_state
                .codex_turns
                .lock()
                .expect("Codex turn ledger mutex poisoned")
                .finish(&event);
            let failed = is_failed_terminal_outcome(outcome);
            if outcome == "transient" {
                return Ok(json!({
                    "ok": true,
                    "accepted": false,
                    "internal": true,
                    "eventId": event_id,
                    "reason": "transient_failure",
                }));
            }
            enqueue_codex_event(
                app,
                app_state,
                codex_terminal_event(&event, turn_state.as_ref(), failed),
            )
        }
        Some(event_type) => Err(format!("Unsupported internal Codex event: {event_type}")),
        None => Err("Internal Codex event is missing event type".to_string()),
    }
}

fn process_codex_event<R: Runtime>(
    app: &AppHandle<R>,
    app_state: &AppState,
    value: Value,
) -> Result<Value, String> {
    let event = normalize_codex_event(value)?;
    if event.get("visibility").and_then(Value::as_str) == Some("internal") {
        return process_internal_codex_event(app, app_state, event);
    }
    enqueue_codex_event(app, app_state, event)
}

fn handle_codex_connection<R: Runtime>(app: &AppHandle<R>, mut stream: TcpStream, token: &str) {
    let response = match read_codex_http_request(&mut stream) {
        Ok(request) => {
            let authorized =
                request.headers.get(CODEX_TOKEN_HEADER).map(String::as_str) == Some(token);
            if !authorized {
                (
                    "401 Unauthorized",
                    json!({ "ok": false, "error": "unauthorized" }),
                )
            } else if request.method == "GET" && request.path == "/v1/health" {
                let state = app.state::<AppState>();
                let pending = state
                    .codex_queue
                    .lock()
                    .expect("Codex queue mutex poisoned")
                    .pending
                    .len();
                (
                    "200 OK",
                    json!({ "ok": true, "protocol": CODEX_PROTOCOL, "pending": pending }),
                )
            } else if request.method == "POST" && request.path == "/v1/events" {
                match serde_json::from_slice::<Value>(&request.body)
                    .map_err(|error| error.to_string())
                    .and_then(|value| process_codex_event(app, &app.state::<AppState>(), value))
                {
                    Ok(payload) => ("200 OK", payload),
                    Err(error) => ("400 Bad Request", json!({ "ok": false, "error": error })),
                }
            } else if request.method == "POST" && request.path == "/v1/ack" {
                let result = serde_json::from_slice::<Value>(&request.body)
                    .map_err(|error| error.to_string())
                    .and_then(|value| {
                        let object = value
                            .as_object()
                            .ok_or_else(|| "Ack body must be a JSON object".to_string())?;
                        let event_id = required_codex_text(object, "event_id", "eventId", 160)?;
                        let state = app.state::<AppState>();
                        let acknowledged = state
                            .codex_queue
                            .lock()
                            .expect("Codex queue mutex poisoned")
                            .acknowledge(&event_id)?;
                        if acknowledged {
                            send_state(app, &state);
                            refresh_reminder_window(app, &state);
                        }
                        Ok::<Value, String>(json!({
                            "ok": true,
                            "acknowledged": acknowledged,
                            "eventId": event_id,
                        }))
                    });
                match result {
                    Ok(payload) => ("200 OK", payload),
                    Err(error) => ("400 Bad Request", json!({ "ok": false, "error": error })),
                }
            } else {
                (
                    "404 Not Found",
                    json!({ "ok": false, "error": "not_found" }),
                )
            }
        }
        Err(error) => ("400 Bad Request", json!({ "ok": false, "error": error })),
    };
    let _ = write_codex_json_response(&mut stream, response.0, response.1);
}

fn start_codex_agent(app: AppHandle) {
    let data_root = app.state::<AppState>().data_root.clone();
    codex_agent_log(&data_root, "thread-start");
    thread::spawn(move || {
        let state = app.state::<AppState>();
        let listener = match TcpListener::bind(("127.0.0.1", 0)) {
            Ok(listener) => listener,
            Err(error) => {
                codex_agent_log(&state.data_root, &format!("bind-error: {error}"));
                eprintln!("Could not start local Codex pet-agent: {error}");
                return;
            }
        };
        if let Err(error) = listener.set_nonblocking(true) {
            codex_agent_log(&state.data_root, &format!("nonblocking-error: {error}"));
            eprintln!("Could not configure local Codex pet-agent: {error}");
            return;
        }
        let Ok(port) = listener.local_addr().map(|address| address.port()) else {
            codex_agent_log(&state.data_root, "local-address-error");
            eprintln!("Could not discover local Codex pet-agent port");
            return;
        };
        let token = codex_token();
        let endpoint_path = match write_codex_endpoint(&state.data_root, port, &token) {
            Ok(path) => path,
            Err(error) => {
                codex_agent_log(&state.data_root, &format!("endpoint-error: {error}"));
                eprintln!("Could not write local Codex endpoint: {error}");
                return;
            }
        };
        codex_agent_log(&state.data_root, &format!("listening:127.0.0.1:{port}"));
        while !state.quitting.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, _)) => {
                    if let Err(error) = stream.set_nonblocking(false) {
                        codex_agent_log(&state.data_root, &format!("connection-error: {error}"));
                        continue;
                    }
                    handle_codex_connection(&app, stream, &token);
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(80));
                }
                Err(error) => {
                    codex_agent_log(&state.data_root, &format!("accept-error: {error}"));
                    eprintln!("Local Codex pet-agent stopped accepting connections: {error}");
                    break;
                }
            }
        }
        codex_agent_log(&state.data_root, "thread-stop");
        let _ = fs::remove_file(endpoint_path);
    });
}

fn load_pets() -> Vec<PetDefinition> {
    if let Ok(catalog) =
        serde_json::from_str::<PetPackCatalog>(include_str!("../../pet-packs/catalog.json"))
    {
        let pets = catalog
            .packs
            .into_iter()
            .filter(|pack| {
                pack.engine == "spine" || pack.engine == "image" || pack.engine == "codex-webp"
            })
            .map(|pack| PetDefinition {
                id: pack.id,
                label: pack.name,
                engine: pack.engine,
                base_animations: pack.actions.raw,
                preview: pack.preview.static_path,
            })
            .collect::<Vec<_>>();
        return pets;
    }
    Vec::new()
}

fn normalize_visible_pets(state: &mut RuntimeState, pets: &[PetDefinition]) {
    let valid_ids = pets
        .iter()
        .map(|pet| pet.id.as_str())
        .collect::<HashSet<_>>();
    let requested = std::mem::take(&mut state.visible_pets);
    let mut seen = HashSet::new();
    let mut visible = requested
        .into_iter()
        .filter(|id| valid_ids.contains(id.as_str()))
        .filter(|id| seen.insert(id.clone()))
        .collect::<Vec<_>>();
    if visible.is_empty() {
        visible = pets.iter().map(|pet| pet.id.clone()).collect();
    }
    if let Some(first) = visible.first() {
        if !visible.iter().any(|id| id == &state.model) {
            state.model = first.clone();
        }
    }
    state.visible_pets = visible;
}

fn load_runtime_state(path: &Path, pets: &[PetDefinition]) -> RuntimeState {
    let fallback = RuntimeState::default();
    let Ok(text) = fs::read_to_string(path) else {
        return fallback;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return fallback;
    };

    let Some(eye_break) = value.get("eyeBreak").and_then(Value::as_object) else {
        return fallback;
    };
    let Some(weekly_report) = value.get("weeklyReport").and_then(Value::as_object) else {
        return fallback;
    };
    let Some(codex) = value.get("codex").and_then(Value::as_object) else {
        return fallback;
    };
    let Some(theme) = value.get("theme").and_then(Value::as_object) else {
        return fallback;
    };

    let mut state = RuntimeState {
        model: value
            .get("model")
            .and_then(Value::as_str)
            .filter(|model| pets.iter().any(|pet| pet.id == *model))
            .unwrap_or(&fallback.model)
            .to_string(),
        visible_pets: value
            .get("visiblePets")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        facing: match value.get("facing").and_then(Value::as_str) {
            Some("left") => "left".to_string(),
            Some("right") => "right".to_string(),
            _ => fallback.facing.clone(),
        },
        interval_ms: clamp_interval(
            eye_break
                .get("intervalMs")
                .and_then(Value::as_i64)
                .unwrap_or(fallback.interval_ms),
        ),
        paused: eye_break
            .get("paused")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        phase: if eye_break.get("phase").and_then(Value::as_str) == Some("due") {
            "due".to_string()
        } else {
            "active".to_string()
        },
        next_due_at: value
            .get("eyeBreak")
            .and_then(|value| value.get("nextDueAt"))
            .and_then(Value::as_i64)
            .unwrap_or(fallback.next_due_at),
        due_at: eye_break
            .get("dueAt")
            .and_then(Value::as_i64)
            .unwrap_or(0),
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
            eye_break
                .get("restDurationMs")
                .and_then(Value::as_i64)
                .unwrap_or(fallback.rest_duration_ms),
        ),
        reminder_title: clean_text(eye_break.get("title"), DEFAULT_REMINDER_TITLE, 80),
        reminder_body: clean_text(eye_break.get("body"), DEFAULT_REMINDER_BODY, 240),
        codex_enabled: codex
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(fallback.codex_enabled),
        eye_break_enabled: eye_break
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(fallback.eye_break_enabled),
        weekly_report_enabled: weekly_report
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(fallback.weekly_report_enabled),
        weekly_report_weekday: clamp_weekly_report_weekday(
            weekly_report
                .get("weekday")
                .and_then(Value::as_i64)
                .unwrap_or(fallback.weekly_report_weekday as i64),
        ),
        weekly_report_time: clean_weekly_report_time(
            weekly_report.get("time"),
            &fallback.weekly_report_time,
        ),
        weekly_report_next_due_at: weekly_report
            .get("nextDueAt")
            .and_then(Value::as_i64)
            .unwrap_or(fallback.weekly_report_next_due_at),
        weekly_report_due_at: weekly_report
            .get("dueAt")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        weekly_report_title: clean_text(
            weekly_report.get("title"),
            DEFAULT_WEEKLY_REPORT_TITLE,
            80,
        ),
        weekly_report_body: clean_text(
            weekly_report.get("body"),
            DEFAULT_WEEKLY_REPORT_BODY,
            240,
        ),
        sound_volume: clamp_sound_volume(
            theme
                .get("soundVolume")
                .and_then(Value::as_f64)
                .unwrap_or(fallback.sound_volume),
        ),
        codex_bubble_scale: clamp_codex_bubble_scale(
            codex
                .get("bubbleScale")
                .and_then(Value::as_f64)
                .unwrap_or(fallback.codex_bubble_scale),
        ),
        reminder_accent: clean_hex_color(theme.get("reminderAccent"), DEFAULT_REMINDER_ACCENT),
        weekly_report_accent: clean_hex_color(
            theme.get("weeklyReportAccent"),
            DEFAULT_WEEKLY_REPORT_ACCENT,
        ),
        codex_completed_accent: clean_hex_color(
            theme.get("codexCompletedAccent"),
            DEFAULT_CODEX_COMPLETED_ACCENT,
        ),
        codex_waiting_accent: clean_hex_color(
            theme.get("codexWaitingAccent"),
            DEFAULT_CODEX_WAITING_ACCENT,
        ),
        codex_failed_accent: clean_hex_color(
            theme.get("codexFailedAccent"),
            DEFAULT_CODEX_FAILED_ACCENT,
        ),
        codex_started_accent: clean_hex_color(
            theme.get("codexStartedAccent"),
            DEFAULT_CODEX_STARTED_ACCENT,
        ),
        paused_remaining_ms: eye_break
            .get("pausedRemainingMs")
            .and_then(Value::as_i64),
    };

    if state.next_due_at <= 0 {
        state.next_due_at = now_ms() + state.interval_ms;
    }
    if state.phase == "due" {
        state.paused = false;
    }
    if state.weekly_report_enabled && state.weekly_report_next_due_at <= 0 {
        state.weekly_report_next_due_at = next_weekly_due_at(
            now_ms(),
            state.weekly_report_weekday,
            &state.weekly_report_time,
        );
    }
    if !state.weekly_report_enabled {
        state.weekly_report_due_at = 0;
        state.weekly_report_next_due_at = 0;
    }
    state
}

#[cfg(windows)]
fn replace_file_atomically(temp_path: &Path, target_path: &Path) -> std::io::Result<()> {
    let source: Vec<u16> = temp_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let target: Vec<u16> = target_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file_atomically(temp_path: &Path, target_path: &Path) -> std::io::Result<()> {
    fs::rename(temp_path, target_path)
}

fn write_file_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let sequence = STATE_WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("state");
    let temp_path = parent.join(format!(".{file_name}.{sequence}.tmp"));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        replace_file_atomically(&temp_path, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn update_runtime_position(app_state: &AppState, position: PositionData) {
    let changed = {
        let mut state = app_state
            .runtime
            .lock()
            .expect("runtime state mutex poisoned");
        let changed = state.position.as_ref().map_or(true, |previous| {
            previous.x != position.x || previous.y != position.y
        });
        if changed {
            state.position = Some(position);
        }
        changed
    };
    if changed {
        app_state.position_revision.fetch_add(1, Ordering::Relaxed);
    }
}

fn save_runtime_state(app_state: &AppState) {
    let position_revision = app_state.position_revision.load(Ordering::Acquire);
    let state = app_state
        .runtime
        .lock()
        .expect("runtime state mutex poisoned")
        .clone();
    let persisted = json!({
        "model": state.model,
        "visiblePets": state.visible_pets,
        "facing": state.facing,
        "position": state.position,
        "displayScale": state.display_scale,
        "eyeBreak": {
            "enabled": state.eye_break_enabled,
            "intervalMs": state.interval_ms,
            "paused": state.paused,
            "phase": state.phase,
            "nextDueAt": state.next_due_at,
            "dueAt": state.due_at,
            "pausedRemainingMs": state.paused_remaining_ms,
            "restDurationMs": state.rest_duration_ms,
            "title": state.reminder_title,
            "body": state.reminder_body,
        },
        "weeklyReport": {
            "enabled": state.weekly_report_enabled,
            "weekday": state.weekly_report_weekday,
            "time": state.weekly_report_time,
            "nextDueAt": state.weekly_report_next_due_at,
            "dueAt": state.weekly_report_due_at,
            "title": state.weekly_report_title,
            "body": state.weekly_report_body,
        },
        "codex": {
            "enabled": state.codex_enabled,
            "bubbleScale": state.codex_bubble_scale,
        },
        "theme": {
            "soundVolume": state.sound_volume,
            "reminderAccent": state.reminder_accent,
            "weeklyReportAccent": state.weekly_report_accent,
            "codexCompletedAccent": state.codex_completed_accent,
            "codexWaitingAccent": state.codex_waiting_accent,
            "codexFailedAccent": state.codex_failed_accent,
            "codexStartedAccent": state.codex_started_accent,
        },
    });
    let bytes = serde_json::to_vec_pretty(&persisted).unwrap_or_default();
    if let Err(error) = write_file_atomically(&app_state.data_root.join("state.json"), &bytes) {
        eprintln!("Could not persist local state: {error}");
        return;
    }
    if app_state.position_revision.load(Ordering::Acquire) == position_revision {
        app_state
            .persisted_position_revision
            .store(position_revision, Ordering::Release);
    }
}

fn save_position_if_needed(app_state: &AppState) {
    let revision = app_state.position_revision.load(Ordering::Acquire);
    if revision != app_state.persisted_position_revision.load(Ordering::Acquire) {
        save_runtime_state(app_state);
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
    let codex_pending = app_state
        .codex_queue
        .lock()
        .expect("Codex queue mutex poisoned")
        .pending
        .clone();
    let codex_event = codex_pending
        .iter()
        .find(|event| event.get("status").and_then(Value::as_str) == Some("waiting_confirmation"))
        .or_else(|| codex_pending.last());
    let notification_type = if state.codex_enabled && !codex_pending.is_empty() {
        "codex"
    } else if state.weekly_report_enabled && state.weekly_report_due_at > 0 {
        "weekly"
    } else if state.eye_break_enabled && state.phase == "due" {
        "eye"
    } else {
        "none"
    };
    let mut value = serde_json::to_value(&state).unwrap_or_else(|_| json!({}));
    if let Value::Object(object) = &mut value {
        object.insert("remainingMs".to_string(), json!(remaining_ms));
        object.insert("availableActions".to_string(), json!(actions));
        object.insert("codexPendingEvents".to_string(), json!(codex_pending));
        object.insert("notificationType".to_string(), json!(notification_type));
        object.insert(
            "notificationTitle".to_string(),
            json!(match notification_type {
                "codex" => codex_event
                    .and_then(|event| event.get("title"))
                    .and_then(Value::as_str)
                    .unwrap_or("Codex 状态更新"),
                "weekly" => state.weekly_report_title.as_str(),
                "eye" => state.reminder_title.as_str(),
                _ => "",
            }),
        );
        object.insert(
            "notificationBody".to_string(),
            json!(match notification_type {
                "codex" => codex_event
                    .and_then(|event| event.get("summary"))
                    .and_then(Value::as_str)
                    .unwrap_or("Codex 有新的状态更新。"),
                "weekly" => state.weekly_report_body.as_str(),
                "eye" => state.reminder_body.as_str(),
                _ => "",
            }),
        );
        object.insert(
            "notificationAccent".to_string(),
            json!(match notification_type {
                "codex" => codex_event
                    .and_then(|event| event.get("status"))
                    .and_then(Value::as_str)
                    .map(|status| codex_accent(&state, status))
                    .unwrap_or_else(|| codex_accent(&state, "started")),
                "weekly" => state.weekly_report_accent.as_str(),
                "eye" => state.reminder_accent.as_str(),
                _ => state.reminder_accent.as_str(),
            }),
        );
        object.insert(
            "notificationRequiresConfirmation".to_string(),
            json!(match notification_type {
                "codex" => codex_event
                    .and_then(|event| event.get("status"))
                    .and_then(Value::as_str)
                    == Some("waiting_confirmation"),
                "weekly" | "eye" => true,
                _ => false,
            }),
        );
    }
    value
}

fn send_state<R: Runtime>(app: &AppHandle<R>, app_state: &AppState) {
    let _ = app.emit("relax-eyes:state", snapshot(app_state));
}

fn codex_accent<'a>(state: &'a RuntimeState, status: &str) -> &'a str {
    match status {
        "completed" => state.codex_completed_accent.as_str(),
        "waiting_confirmation" => state.codex_waiting_accent.as_str(),
        "failed" => state.codex_failed_accent.as_str(),
        _ => state.codex_started_accent.as_str(),
    }
}

fn send_event<R: Runtime>(app: &AppHandle<R>, event_type: &str, payload: Value) {
    let mut event = match payload {
        Value::Object(object) => object,
        _ => serde_json::Map::new(),
    };
    event.insert("type".to_string(), Value::String(event_type.to_string()));
    let _ = app.emit("relax-eyes:event", Value::Object(event));
}

fn codex_notifications_active(app_state: &AppState) -> bool {
    let codex_enabled = app_state
        .runtime
        .lock()
        .expect("runtime state mutex poisoned")
        .codex_enabled;
    let has_pending = !app_state
        .codex_queue
        .lock()
        .expect("Codex queue mutex poisoned")
        .pending
        .is_empty();
    codex_enabled && has_pending
}

fn runtime_is_due(app_state: &AppState) -> bool {
    let state = app_state
        .runtime
        .lock()
        .expect("runtime state mutex poisoned");
    state.eye_break_enabled && state.phase == "due"
}

fn weekly_report_is_due(app_state: &AppState) -> bool {
    let state = app_state
        .runtime
        .lock()
        .expect("runtime state mutex poisoned");
    state.weekly_report_enabled && state.weekly_report_due_at > 0
}

fn refresh_reminder_window<R: Runtime>(app: &AppHandle<R>, _app_state: &AppState) {
    let callback_app = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let state = callback_app.state::<AppState>();
        if codex_notifications_active(&state)
            || (!runtime_is_due(&state) && !weekly_report_is_due(&state))
        {
            hide_reminder_window_on_main(&callback_app);
            return;
        }
        if let Err(error) = show_reminder_window_on_main(&callback_app) {
            eprintln!("Could not open reminder window: {error}");
        }
    }) {
        eprintln!("Could not schedule reminder window refresh: {error}");
    }
}

fn window_size_for_scale(scale: f64) -> f64 {
    (BASE_WINDOW_SIZE * clamp_display_scale(scale) / WINDOW_REFERENCE_SCALE)
        .round()
        .max(MIN_WINDOW_SIZE)
}

fn inset_pixels(size: f64, value: f64) -> f64 {
    size * value.clamp(0.0, MAX_CONTENT_INSET)
}

fn monitor_work_area<R: Runtime>(
    app: &AppHandle<R>,
    app_state: &AppState,
    x: f64,
    y: f64,
) -> Option<WorkArea> {
    let now = now_ms();
    if let Some(cached) = app_state
        .work_area_cache
        .lock()
        .expect("work area cache mutex poisoned")
        .as_ref()
        .copied()
        .filter(|cached| {
            now < cached.expires_at
                && x >= cached.monitor_bounds.x
                && x <= cached.monitor_bounds.x + cached.monitor_bounds.width
                && y >= cached.monitor_bounds.y
                && y <= cached.monitor_bounds.y + cached.monitor_bounds.height
        })
    {
        return Some(cached.area);
    }
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
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let work_area = monitor.work_area();
    let area = WorkArea {
        x: work_area.position.x as f64 / scale,
        y: work_area.position.y as f64 / scale,
        width: work_area.size.width as f64 / scale,
        height: work_area.size.height as f64 / scale,
    };
    *app_state
        .work_area_cache
        .lock()
        .expect("work area cache mutex poisoned") = Some(CachedWorkArea {
        area,
        monitor_bounds: WorkArea {
            x: monitor_position.x as f64 / scale,
            y: monitor_position.y as f64 / scale,
            width: monitor_size.width as f64 / scale,
            height: monitor_size.height as f64 / scale,
        },
        expires_at: now + WORK_AREA_CACHE_TTL_MS,
    });
    Some(area)
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
    let area = monitor_work_area(app, app_state, x + size / 2.0, y + size / 2.0)
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

fn hide_reminder_window_on_main<R: Runtime>(app: &AppHandle<R>) {
    app.state::<AppState>()
        .reminder_generation
        .fetch_add(1, Ordering::Relaxed);
    if let Some(window) = app.get_webview_window("reminder") {
        let _ = window.hide();
    }
}

fn hide_reminder_window<R: Runtime>(app: &AppHandle<R>) {
    app.state::<AppState>()
        .reminder_generation
        .fetch_add(1, Ordering::Relaxed);
    let callback_app = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if let Some(window) = callback_app.get_webview_window("reminder") {
            let _ = window.hide();
        }
    }) {
        eprintln!("Could not schedule reminder window hide: {error}");
    }
}

fn reminder_position<R: Runtime>(app: &AppHandle<R>) -> PositionData {
    let app_state = app.state::<AppState>();
    let (pet_x, pet_y, pet_size) = app
        .get_webview_window("main")
        .and_then(|window| {
            current_window_geometry(&window)
                .ok()
                .map(|geometry| (geometry.x, geometry.y, geometry.size))
        })
        .unwrap_or((0.0, 0.0, 0.0));
    let area = monitor_work_area(
        app,
        &app_state,
        pet_x + pet_size / 2.0,
        pet_y + pet_size / 2.0,
    )
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

fn show_reminder_window_on_main<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let generation = app
        .state::<AppState>()
        .reminder_generation
        .fetch_add(1, Ordering::Relaxed)
        .saturating_add(1);
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
        if app_handle
            .state::<AppState>()
            .reminder_generation
            .load(Ordering::Relaxed)
            == generation
        {
            hide_reminder_window(&app_handle);
        }
    });
    Ok(())
}

fn open_size_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let app_state = app.state::<AppState>();
    if let Some(window) = app.get_webview_window("settings") {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        if let Some(state) = app.try_state::<AppState>() {
            send_state(app, &state);
        }
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
    let width = 460.0;
    let height = 720.0;
    let area = monitor_work_area(
        app,
        &app_state,
        pet_x + pet_size / 2.0,
        pet_y + pet_size / 2.0,
    )
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
    save_runtime_state(app_state);
    send_event(app, "timer-reset", json!({ "source": source }));
    send_state(app, app_state);
    refresh_reminder_window(app, app_state);
}

fn mark_due<R: Runtime>(app: &AppHandle<R>, app_state: &AppState) {
    {
        let mut state = app_state
            .runtime
            .lock()
            .expect("runtime state mutex poisoned");
        if !state.eye_break_enabled || state.phase == "due" {
            return;
        }
        state.phase = "due".to_string();
        state.due_at = now_ms();
        state.paused = false;
    }
    save_runtime_state(app_state);
    send_event(app, "reminder-due", json!({}));
    send_state(app, app_state);
    refresh_reminder_window(app, app_state);
}

fn mark_weekly_due<R: Runtime>(app: &AppHandle<R>, app_state: &AppState) {
    {
        let mut state = app_state
            .runtime
            .lock()
            .expect("runtime state mutex poisoned");
        let now = now_ms();
        if !state.weekly_report_enabled
            || state.weekly_report_due_at > 0
            || state.weekly_report_next_due_at <= 0
            || now < state.weekly_report_next_due_at
        {
            return;
        }
        state.weekly_report_due_at = now;
    }
    save_runtime_state(app_state);
    send_event(app, "weekly-report-due", json!({}));
    send_state(app, app_state);
    refresh_reminder_window(app, app_state);
}

fn reset_weekly_report<R: Runtime>(app: &AppHandle<R>, app_state: &AppState, source: &str) {
    {
        let mut state = app_state
            .runtime
            .lock()
            .expect("runtime state mutex poisoned");
        if state.weekly_report_due_at <= 0 {
            return;
        }
        state.weekly_report_due_at = 0;
        state.weekly_report_next_due_at = next_weekly_due_at(
            now_ms(),
            state.weekly_report_weekday,
            &state.weekly_report_time,
        );
    }
    save_runtime_state(app_state);
    send_event(app, "weekly-report-reset", json!({ "source": source }));
    send_state(app, app_state);
    refresh_reminder_window(app, app_state);
}

fn start_timer(app: AppHandle) {
    thread::spawn(move || loop {
        let app_state = app.state::<AppState>();
        if app_state.quitting.load(Ordering::Relaxed) {
            break;
        }
        let (eye_due, weekly_due) = {
            let state = app_state
                .runtime
                .lock()
                .expect("runtime state mutex poisoned");
            let now = now_ms();
            (
                state.eye_break_enabled
                    && !state.paused
                    && state.phase == "active"
                    && now >= state.next_due_at,
                state.weekly_report_enabled
                    && state.weekly_report_due_at == 0
                    && state.weekly_report_next_due_at > 0
                    && now >= state.weekly_report_next_due_at,
            )
        };
        if weekly_due {
            mark_weekly_due(&app, &app_state);
        }
        if eye_due {
            mark_due(&app, &app_state);
        }
        save_position_if_needed(&app_state);
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
        } else if codex_notifications_active(&app_state)
            || runtime_is_due(&app_state)
            || weekly_report_is_due(&app_state)
        {
            // Actionable states must remain clickable while the pet window moves.
            // Otherwise the native hit test can make the window passthrough between
            // two animation frames and the next click never reaches the renderer.
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
    let settings_item = MenuItem::with_id(app, "tray:settings", "宠物设置", true, None::<&str>)?;
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
            update_runtime_position(&state, PositionData {
                x: geometry.x,
                y: geometry.y,
            });
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
fn get_window_position(app: AppHandle) -> Result<PositionData, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window is missing")?;
    let geometry = current_window_geometry(&window)?;
    Ok(PositionData {
        x: geometry.x,
        y: geometry.y,
    })
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
) -> Result<PositionData, String> {
    if !x.is_finite() || !y.is_finite() {
        let window = app
            .get_webview_window("main")
            .ok_or("main window is missing")?;
        let geometry = current_window_geometry(&window)?;
        return Ok(PositionData {
            x: geometry.x,
            y: geometry.y,
        });
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
        update_runtime_position(app_state, position.clone());
        save_runtime_state(app_state);
        send_state(app, app_state);
    }
    Ok(PositionData {
        x: position.x,
        y: position.y,
    })
}

#[tauri::command]
fn move_window_command(
    app: AppHandle,
    state: State<'_, AppState>,
    x: f64,
    y: f64,
) -> Result<PositionData, String> {
    move_window(&app, &state, x, y, false)
}

#[tauri::command]
fn end_drag(app: AppHandle, state: State<'_, AppState>, x: f64, y: f64) -> Result<(), String> {
    let result = move_window(&app, &state, x, y, true).map(|_| ());
    state.dragging.store(false, Ordering::Relaxed);
    result
}

#[tauri::command]
fn cancel_drag(state: State<'_, AppState>) {
    state.dragging.store(false, Ordering::Relaxed);
}

#[tauri::command]
fn pet_click(app: AppHandle, state: State<'_, AppState>) {
    let (weekly_due, eye_due) = {
        let runtime = state.runtime.lock().expect("runtime state mutex poisoned");
        (
            runtime.weekly_report_enabled && runtime.weekly_report_due_at > 0,
            runtime.eye_break_enabled && runtime.phase == "due",
        )
    };
    if weekly_due {
        reset_weekly_report(&app, &state, "pet-click");
    } else if eye_due {
        send_reset(&app, &state, "pet-click");
    }
    send_event(&app, "pet-click", json!({}));
}

#[tauri::command]
fn ack_codex_event(
    app: AppHandle,
    state: State<'_, AppState>,
    event_id: String,
) -> Result<(), String> {
    let event_id = event_id.trim();
    if event_id.is_empty() || event_id.len() > 160 {
        return Err("Invalid Codex event ID".to_string());
    }
    let acknowledged = state
        .codex_queue
        .lock()
        .expect("Codex queue mutex poisoned")
        .acknowledge(event_id)?;
    if acknowledged {
        send_event(&app, "codex-event-ack", json!({ "eventId": event_id }));
        send_state(&app, &state);
        refresh_reminder_window(&app, &state);
    }
    Ok(())
}

#[tauri::command]
fn confirm_reminder(app: AppHandle, state: State<'_, AppState>) {
    let (weekly_due, eye_due) = {
        let runtime = state.runtime.lock().expect("runtime state mutex poisoned");
        (
            runtime.weekly_report_enabled && runtime.weekly_report_due_at > 0,
            runtime.eye_break_enabled && runtime.phase == "due",
        )
    };
    if weekly_due {
        reset_weekly_report(&app, &state, "reminder-window");
    } else if eye_due {
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
fn close_size_panel(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
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
        &state,
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
    }
    update_runtime_position(&state, position);
    save_runtime_state(&state);
    send_state(&app, &state);
    Ok(())
}

#[tauri::command]
fn set_reminder_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: Value,
) -> Result<(), String> {
    let eye_break = settings
        .get("eyeBreak")
        .and_then(Value::as_object)
        .ok_or_else(|| "Settings are missing the eyeBreak group".to_string())?;
    let weekly_report = settings
        .get("weeklyReport")
        .and_then(Value::as_object)
        .ok_or_else(|| "Settings are missing the weeklyReport group".to_string())?;
    let codex = settings
        .get("codex")
        .and_then(Value::as_object)
        .ok_or_else(|| "Settings are missing the codex group".to_string())?;
    let theme = settings
        .get("theme")
        .and_then(Value::as_object)
        .ok_or_else(|| "Settings are missing the theme group".to_string())?;
    let (interval_changed, codex_changed, weekly_changed, eye_reset) = {
        let mut runtime = state.runtime.lock().expect("runtime state mutex poisoned");
        let mut changed = false;
        let mut codex_changed = false;
        let mut weekly_changed = false;
        let mut eye_reset = false;
        if let Some(minutes) = eye_break
            .get("intervalMinutes")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
        {
            let next = clamp_interval((minutes * 60_000.0).round() as i64);
            changed = next != runtime.interval_ms;
            runtime.interval_ms = next;
        }
        if let Some(seconds) = eye_break
            .get("restSeconds")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
        {
            runtime.rest_duration_ms = clamp_rest_duration((seconds * 1000.0).round() as i64);
        }
        if eye_break.get("title").is_some() {
            runtime.reminder_title = clean_text(eye_break.get("title"), DEFAULT_REMINDER_TITLE, 80);
        }
        if eye_break.get("body").is_some() {
            runtime.reminder_body = clean_text(eye_break.get("body"), DEFAULT_REMINDER_BODY, 240);
        }
        if let Some(enabled) = codex.get("enabled").and_then(Value::as_bool) {
            codex_changed = enabled != runtime.codex_enabled;
            runtime.codex_enabled = enabled;
        }
        if let Some(enabled) = eye_break.get("enabled").and_then(Value::as_bool) {
            if !enabled && runtime.phase == "due" {
                runtime.phase = "active".to_string();
                runtime.due_at = 0;
                runtime.paused = false;
                eye_reset = true;
            }
            runtime.eye_break_enabled = enabled;
        }
        if let Some(enabled) = weekly_report.get("enabled").and_then(Value::as_bool) {
            weekly_changed = enabled != runtime.weekly_report_enabled;
            runtime.weekly_report_enabled = enabled;
        }
        if let Some(weekday) = weekly_report.get("weekday").and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_f64().map(|value| value.round() as i64))
        }) {
            let next = clamp_weekly_report_weekday(weekday);
            weekly_changed = weekly_changed || next != runtime.weekly_report_weekday;
            runtime.weekly_report_weekday = next;
        }
        if weekly_report.get("time").is_some() {
            let next = clean_weekly_report_time(
                weekly_report.get("time"),
                &runtime.weekly_report_time,
            );
            weekly_changed = weekly_changed || next != runtime.weekly_report_time;
            runtime.weekly_report_time = next;
        }
        if weekly_report.get("title").is_some() {
            runtime.weekly_report_title = clean_text(
                weekly_report.get("title"),
                DEFAULT_WEEKLY_REPORT_TITLE,
                80,
            );
        }
        if weekly_report.get("body").is_some() {
            runtime.weekly_report_body = clean_text(
                weekly_report.get("body"),
                DEFAULT_WEEKLY_REPORT_BODY,
                240,
            );
        }
        if let Some(volume) = theme
            .get("soundVolume")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
        {
            runtime.sound_volume = clamp_sound_volume(volume);
        }
        if let Some(scale) = codex
            .get("bubbleScale")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
        {
            runtime.codex_bubble_scale = clamp_codex_bubble_scale(scale);
        }
        if theme.get("reminderAccent").is_some() {
            runtime.reminder_accent =
                clean_hex_color(theme.get("reminderAccent"), &runtime.reminder_accent);
        }
        if theme.get("weeklyReportAccent").is_some() {
            runtime.weekly_report_accent = clean_hex_color(
                theme.get("weeklyReportAccent"),
                &runtime.weekly_report_accent,
            );
        }
        if theme.get("codexCompletedAccent").is_some() {
            runtime.codex_completed_accent = clean_hex_color(
                theme.get("codexCompletedAccent"),
                &runtime.codex_completed_accent,
            );
        }
        if theme.get("codexWaitingAccent").is_some() {
            runtime.codex_waiting_accent = clean_hex_color(
                theme.get("codexWaitingAccent"),
                &runtime.codex_waiting_accent,
            );
        }
        if theme.get("codexFailedAccent").is_some() {
            runtime.codex_failed_accent = clean_hex_color(
                theme.get("codexFailedAccent"),
                &runtime.codex_failed_accent,
            );
        }
        if theme.get("codexStartedAccent").is_some() {
            runtime.codex_started_accent = clean_hex_color(
                theme.get("codexStartedAccent"),
                &runtime.codex_started_accent,
            );
        }
        if !runtime.weekly_report_enabled {
            if runtime.weekly_report_due_at > 0 || runtime.weekly_report_next_due_at > 0 {
                weekly_changed = true;
            }
            runtime.weekly_report_due_at = 0;
            runtime.weekly_report_next_due_at = 0;
        } else if weekly_changed
            || (runtime.weekly_report_due_at == 0 && runtime.weekly_report_next_due_at <= 0)
        {
            runtime.weekly_report_due_at = 0;
            runtime.weekly_report_next_due_at = next_weekly_due_at(
                now_ms(),
                runtime.weekly_report_weekday,
                &runtime.weekly_report_time,
            );
        }
        (changed, codex_changed, weekly_changed, eye_reset)
    };
    if interval_changed || eye_reset {
        send_reset(&app, &state, "settings-change");
    } else {
        save_runtime_state(&state);
        send_state(&app, &state);
    }
    if codex_changed || weekly_changed {
        refresh_reminder_window(&app, &state);
    }
    Ok(())
}

#[tauri::command]
fn set_visible_pets(
    app: AppHandle,
    state: State<'_, AppState>,
    visible_pets: Vec<String>,
) -> Result<(), String> {
    let requested = visible_pets.into_iter().collect::<HashSet<_>>();
    let selected = state
        .pets
        .iter()
        .filter(|pet| requested.contains(&pet.id))
        .map(|pet| pet.id.clone())
        .collect::<Vec<_>>();
    if selected.is_empty() {
        return Err("At least one pet must remain visible".to_string());
    }

    let (changed, model_changed, model_id) = {
        let mut runtime = state.runtime.lock().expect("runtime state mutex poisoned");
        let model_changed = !selected.iter().any(|id| id == &runtime.model);
        if model_changed {
            runtime.model = selected[0].clone();
        }
        let changed = runtime.visible_pets != selected || model_changed;
        runtime.visible_pets = selected;
        (changed, model_changed, runtime.model.clone())
    };

    if changed {
        save_runtime_state(&state);
        if model_changed {
            send_event(&app, "model-change", json!({ "model": model_id }));
        }
        send_state(&app, &state);
    }
    Ok(())
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
    update_runtime_position(&state, position);
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
    let visible = state
        .runtime
        .lock()
        .expect("runtime state mutex poisoned")
        .visible_pets
        .clone();
    if !visible.is_empty() && !visible.iter().any(|id| id == &model_id) {
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
fn set_facing(app: AppHandle, state: State<'_, AppState>, facing: String) -> Result<(), String> {
    let next_facing = match facing.as_str() {
        "left" | "right" => facing,
        _ => return Err("Invalid pet facing".to_string()),
    };
    let changed = {
        let mut runtime = state.runtime.lock().expect("runtime state mutex poisoned");
        if runtime.facing == next_facing {
            false
        } else {
            runtime.facing = next_facing;
            true
        }
    };
    if changed {
        save_runtime_state(&state);
        send_state(&app, &state);
    }
    Ok(())
}

#[tauri::command]
fn play_animation(app: AppHandle, name: String) {
    send_event(&app, "play-animation", json!({ "name": name }));
}

#[tauri::command]
fn toggle_pause(app: AppHandle, state: State<'_, AppState>) {
    {
        let mut runtime = state.runtime.lock().expect("runtime state mutex poisoned");
        if runtime.phase == "due" || !runtime.eye_break_enabled {
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
    clear_codex_endpoint(&state.data_root);
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if !acquire_single_instance() {
        let message = "检测到 Relax Eyes 已经在运行，本次启动已退出。";
        show_webview2_error(message);
        eprintln!("{message}");
        return;
    }
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
    let mut runtime = load_runtime_state(&state_path, &pets);
    normalize_visible_pets(&mut runtime, &pets);
    let codex_queue = CodexQueue::load(&data_root);
    let app_state = AppState {
        runtime: Mutex::new(runtime),
        actions: Mutex::new(HashMap::new()),
        codex_queue: Mutex::new(codex_queue),
        codex_turns: Mutex::new(CodexTurnLedger::default()),
        content_insets: Mutex::new(ContentInsets::default()),
        position_revision: AtomicU64::new(0),
        persisted_position_revision: AtomicU64::new(0),
        work_area_cache: Mutex::new(None),
        dragging: AtomicBool::new(false),
        mouse_ignored: AtomicBool::new(true),
        data_root,
        pets,
        quitting: AtomicBool::new(false),
        reminder_generation: AtomicU64::new(0),
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
            start_codex_agent(app.handle().clone());
            save_runtime_state(&state);
            create_main_window(app.handle(), &state)?;
            configure_main_window(app.handle(), &state)?;
            create_tray(app)?;
            start_timer(app.handle().clone());
            start_mouse_hit_test(app.handle().clone());
            send_state(app.handle(), &state);
            refresh_reminder_window(app.handle(), &state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            get_pet_catalog,
            get_window_position,
            begin_drag,
            move_window_command,
            end_drag,
            cancel_drag,
            pet_click,
            ack_codex_event,
            confirm_reminder,
            open_size_panel,
            close_size_panel,
            set_display_scale,
            set_reminder_settings,
            set_visible_pets,
            set_content_insets,
            set_ignore_mouse,
            set_model_actions,
            change_model,
            set_facing,
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
                    clear_codex_endpoint(&state.data_root);
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "settings" {
                    api.prevent_close();
                    let _ = window.emit("relax-eyes:settings-close-requested", json!({}));
                } else if window.label() == "main" {
                    if let Some(state) = window.app_handle().try_state::<AppState>() {
                        if !state.quitting.load(Ordering::Relaxed) {
                            api.prevent_close();
                            let _ = window.hide();
                        }
                    }
                }
            }
            if window.label() == "main" && matches!(event, WindowEvent::Destroyed) {
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    state.quitting.store(true, Ordering::Relaxed);
                    clear_codex_endpoint(&state.data_root);
                }
                window.app_handle().exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn internal_event(event_type: &str, terminal_outcome: Option<&str>) -> Value {
        let mut event = json!({
            "protocol": CODEX_PROTOCOL,
            "event_id": "test-event",
            "event_type": event_type,
            "status": "observed",
            "title": "test",
            "summary": "test",
            "details": [],
            "source": "test",
            "project": "test",
            "created_at": "2026-08-10T00:00:00Z",
            "visibility": "internal",
            "session_id": "session-test",
            "turn_id": "turn-test",
        });
        if let Some(outcome) = terminal_outcome {
            event["terminal_outcome"] = Value::String(outcome.to_string());
        }
        event
    }

    #[test]
    fn internal_events_are_scoped_to_session_and_turn() {
        let mut ledger = CodexTurnLedger::default();
        let candidate = normalize_codex_event(internal_event("tool_failure_candidate", None))
            .expect("tool failure candidate should normalize");
        assert!(ledger.observe_failure(&candidate));

        let mut other_turn = candidate.clone();
        other_turn["turnId"] = Value::String("other-turn".to_string());
        assert!(ledger.finish(&other_turn).is_none());

        let state = ledger.finish(&candidate).expect("candidate should be retained");
        assert_eq!(state.failure_reason, None);
        assert!(ledger.finish(&candidate).is_none());
    }

    #[test]
    fn internal_turn_stop_requires_valid_outcome() {
        let event = normalize_codex_event(internal_event("turn_stop", Some("transient")))
            .expect("turn_stop should normalize");
        assert_eq!(event["visibility"], "internal");
        assert_eq!(event["sessionId"], "session-test");
        assert_eq!(event["turnId"], "turn-test");
        assert_eq!(event["terminalOutcome"], "transient");
    }

    #[test]
    fn terminal_event_is_converted_to_visible_completion() {
        let internal = normalize_codex_event(internal_event("turn_stop", Some("completed")))
            .expect("turn_stop should normalize");
        let visible = codex_terminal_event(&internal, None, false);
        assert_eq!(visible["eventType"], "task_completed");
        assert_eq!(visible["status"], "completed");
        assert_eq!(visible["requiresConfirmation"], false);
        assert!(visible.get("visibility").is_none());
    }

    #[test]
    fn failed_terminal_event_is_visible_without_tool_candidate() {
        let internal = normalize_codex_event(internal_event("turn_stop", Some("failed_candidate")))
            .expect("failed turn_stop should normalize");
        let visible = codex_terminal_event(
            &internal,
            None,
            is_failed_terminal_outcome("failed_candidate"),
        );
        assert_eq!(visible["eventType"], "task_failed");
        assert_eq!(visible["status"], "failed");
    }
}
