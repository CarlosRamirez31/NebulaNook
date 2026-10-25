//! Bounded, local display data for a tool that has already finished.
use serde_json::{json, Map, Value};
use std::{io::Read, path::{Path, PathBuf}, sync::mpsc, time::Duration};

const MAX_TEXT: u64 = 128 * 1024;

pub fn capture(map: &Map<String, Value>, event: &str, cwd: &str) -> Option<Value> {
    if !matches!(event, "PostToolUse" | "PostToolUseFailure") { return None; }
    let map = map.clone();
    let cwd = cwd.to_string();
    let completed = event == "PostToolUse";
    // Files on a disconnected mount must never hold the agent's hook open.
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || { let _ = tx.send(collect(&map, &cwd, completed)); });
    rx.recv_timeout(Duration::from_millis(120)).ok()
}

fn collect(map: &Map<String, Value>, cwd: &str, completed: bool) -> Value {
    let tool = map.get("tool_name").and_then(Value::as_str).unwrap_or("");
    let tool = tool.rsplit(['.', ':', '/']).next().unwrap_or(tool).to_lowercase();
    let input = map.get("tool_input").and_then(Value::as_object);
    let string = |key: &str| input.and_then(|v| v.get(key)).and_then(Value::as_str);
    let terminal = matches!(tool.as_str(), "bash" | "shell" | "terminal" | "exec_command" | "run_command" | "powershell");
    let mut out = json!({});
    if terminal {
        let response = map.get("tool_response").or_else(|| map.get("tool_output"));
        let output = response.and_then(Value::as_str).or_else(|| {
            response.and_then(|v| v.get("output").or_else(|| v.get("stdout"))).and_then(Value::as_str)
        }).unwrap_or("");
        out["terminal"] = json!({ "command": string("command").or_else(|| string("cmd")).unwrap_or(""),
            "output": output.chars().take(4000).collect::<String>(), "failed": !completed });
    }
    let file_tool = super::DIFF_TOOLS.contains(&tool.as_str()) || matches!(tool.as_str(), "read" | "read_file" | "view_file");
    if !completed || !file_tool { return out; }
    let mut paths: Vec<String> = ["file_path", "filePath", "path", "file", "TargetFile", "AbsolutePath"]
        .iter().filter_map(|key| string(key).map(str::to_string)).take(1).collect();
    if matches!(tool.as_str(), "apply_patch" | "patch") {
        if let Some(patch) = string("patch").or_else(|| string("input")).or_else(|| string("patchText")) {
            for line in patch.lines() {
                for prefix in ["*** Update File: ", "*** Add File: ", "*** Move to: "] {
                    if let Some(path) = line.strip_prefix(prefix) { paths.push(path.to_string()); }
                }
            }
        }
    }
    let base = map.get("cwd").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(cwd);
    let mut budget = MAX_TEXT;
    let mut previews = Vec::new();
    paths.sort(); paths.dedup();
    for path in paths.into_iter().take(32) {
        if let Some(preview) = read_preview(&path, base, &mut budget) { previews.push(preview); }
    }
    out["files"] = json!(previews);
    out
}

fn read_preview(path: &str, cwd: &str, budget: &mut u64) -> Option<Value> {
    let path = if Path::new(path).is_absolute() { PathBuf::from(path) } else { Path::new(cwd).join(path) };
    let canonical = path.canonicalize().ok()?;
    if ["/proc", "/sys", "/dev"].iter().any(|root| canonical.starts_with(root)) { return None; }
    let meta = canonical.metadata().ok()?;
    if !meta.is_file() || meta.len() > *budget { return None; }
    let mut bytes = Vec::new();
    std::fs::File::open(canonical).ok()?.take(*budget + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > *budget || bytes.contains(&0) { return None; }
    let content = String::from_utf8(bytes).ok()?;
    if content.lines().count() > 4000 { return None; }
    *budget = budget.saturating_sub(content.len() as u64);
    Some(json!({ "path": path.to_string_lossy(), "content": content }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_completed_regular_text_files_are_read() {
        let dir = std::env::temp_dir().join(format!("nebulanook-preview-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("notes.md"), "real file\n").unwrap();
        std::fs::write(dir.join("binary"), b"\0binary").unwrap();
        let map = json!({"tool_name":"Read", "tool_input":{"file_path":"notes.md"}}).as_object().unwrap().clone();
        let data = collect(&map, dir.to_str().unwrap(), true);
        assert_eq!(data["files"][0]["content"], "real file\n");
        assert!(collect(&map, dir.to_str().unwrap(), false).get("files").is_none());
        let mut budget = MAX_TEXT;
        assert!(read_preview("binary", dir.to_str().unwrap(), &mut budget).is_none());
        assert!(read_preview(".", dir.to_str().unwrap(), &mut budget).is_none());
        assert!(capture(&map, "PermissionRequest", dir.to_str().unwrap()).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
