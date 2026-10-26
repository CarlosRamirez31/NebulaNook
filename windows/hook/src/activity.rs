//! Bounded, local snapshots and reported command output at tool boundaries.
use serde_json::{json, Map, Value};
use std::{io::Read, path::{Path, PathBuf}, sync::mpsc, time::Duration};

const MAX_TEXT: u64 = 128 * 1024;

pub fn capture(map: &Map<String, Value>, event: &str, cwd: &str) -> Option<Value> {
    if !matches!(event, "PreToolUse" | "PostToolUse" | "PostToolUseFailure") { return None; }
    if event == "PreToolUse" {
        let name = map.get("tool_name").and_then(Value::as_str).unwrap_or("");
        let name = name.rsplit(['.', ':', '/']).next().unwrap_or(name).to_lowercase();
        let command = map.get("tool_input").and_then(|v| v.get("command").or_else(|| v.get("cmd"))).and_then(Value::as_str).unwrap_or("");
        if !super::DIFF_TOOLS.contains(&name.as_str()) && !matches!(name.as_str(), "read" | "read_file" | "view_file") && literal_read_paths(command).is_empty() {
            return None;
        }
    }
    let map = map.clone();
    let cwd = cwd.to_string();
    let completed = event != "PostToolUseFailure";
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
    let terminal = matches!(tool.as_str(), "bash" | "shell" | "terminal" | "exec_command" | "run_command" | "powershell" | "exec" | "wait" | "write_stdin");
    let mut out = json!({});
    if terminal {
        let response = map.get("tool_response").or_else(|| map.get("tool_output"));
        let output = response.map(|v| response_text(v, 0)).unwrap_or_default();
        let failed = !completed || response.is_some_and(|v| response_failed(v, 0));
        let process = response.and_then(|v| response_process(v, 0))
            .or_else(|| input.and_then(|v| v.get("session_id")).map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())));
        out["terminal"] = json!({ "command": string("command").or_else(|| string("cmd")).unwrap_or(""),
            "output": bounded(&output), "failed": failed, "processId": process });
    }
    let shell_paths = if terminal { literal_read_paths(string("command").or_else(|| string("cmd")).unwrap_or("")) } else { Vec::new() };
    let file_tool = super::DIFF_TOOLS.contains(&tool.as_str()) || matches!(tool.as_str(), "read" | "read_file" | "view_file") || !shell_paths.is_empty();
    if !completed || !file_tool { return out; }
    let mut paths: Vec<String> = ["file_path", "filePath", "path", "file", "TargetFile", "AbsolutePath"]
        .iter().filter_map(|key| string(key).map(str::to_string)).take(1).collect();
    paths.extend(shell_paths);
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

/// Read only explicitly named files in literal cat/sed/head/tail commands.
/// This parser never evaluates a shell, expansions, substitutions or heredocs.
fn literal_read_paths(command: &str) -> Vec<String> {
    if command.contains("<<") { return Vec::new(); }
    let mut commands = Vec::new();
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut escaped = false;
    for ch in command.chars().chain(std::iter::once('\n')) {
        if escaped { word.push(ch); escaped = false; continue; }
        if ch == '\\' && quote != Some('\'') { escaped = true; continue; }
        if let Some(q) = quote {
            if ch == q { quote = None; }
            else if q == '"' && matches!(ch, '$' | '`') { return Vec::new(); }
            else { word.push(ch); }
            continue;
        }
        match ch {
            '\'' | '"' => quote = Some(ch),
            '$' | '`' | '<' | '>' | '(' | ')' => return Vec::new(),
            ';' | '|' | '&' | '\n' => {
                if !word.is_empty() { words.push(std::mem::take(&mut word)); }
                if !words.is_empty() { commands.push(std::mem::take(&mut words)); }
            }
            c if c.is_whitespace() => {
                if !word.is_empty() { words.push(std::mem::take(&mut word)); }
            }
            _ => word.push(ch),
        }
    }
    if quote.is_some() || escaped { return Vec::new(); }
    let mut paths = Vec::new();
    for words in commands {
        let tool = Path::new(&words[0]).file_name().and_then(|s| s.to_str()).unwrap_or("");
        let start = match tool {
            "cat" => if words.get(1).is_some_and(|s| s == "--") { 2 } else { 1 },
            "sed" if words.get(1).is_some_and(|s| s == "-n") && words.get(2).is_some_and(|s|
                s.ends_with('p') && s[..s.len() - 1].split(',').all(|n| n.parse::<usize>().is_ok_and(|n| n > 0))) => 3,
            "head" | "tail" => match words.get(1).map(String::as_str) {
                Some("-n") if words.get(2).is_some_and(|s| s.parse::<usize>().is_ok()) => 3,
                Some(s) if s.starts_with('-') && s[1..].parse::<usize>().is_ok() => 2,
                _ => 1,
            },
            _ => continue,
        };
        for path in words.into_iter().skip(start) {
            if path.starts_with('-') { break; }
            paths.push(path);
            if paths.len() == 32 { return paths; }
        }
    }
    paths
}

fn bounded(text: &str) -> String {
    if text.chars().count() <= 16_000 { return text.to_string(); }
    let tail: String = text.chars().rev().take(7_900).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{}\n…\n{}", text.chars().take(7_900).collect::<String>(), tail)
}

fn transcript_values(text: &str) -> Vec<Value> {
    if text.len() > 256 * 1024 || !(text.starts_with("Script completed") || text.starts_with("Script running") || text.starts_with("Script failed")) {
        return Vec::new();
    }
    let Some((_, body)) = text.split_once("\nOutput:\n") else { return Vec::new() };
    serde_json::Deserializer::from_str(body).into_iter::<Value>().take(64).map_while(Result::ok).collect()
}

// Cursor may encode stdout in JSON; MCP tools return text content blocks.
fn response_text(value: &Value, depth: usize) -> String {
    if depth > 6 { return String::new(); }
    match value {
        Value::String(s) => {
            let values = transcript_values(s);
            if !values.is_empty() { return response_text(&Value::Array(values), depth + 1); }
            if s.len() <= 256 * 1024 && (s.starts_with('{') || s.starts_with('[')) {
                if let Ok(parsed) = serde_json::from_str::<Value>(s) {
                    let text = response_text(&parsed, depth + 1);
                    if !text.is_empty() { return text; }
                }
            }
            bounded(s)
        }
        Value::Array(values) => bounded(&values.iter().take(64).map(|v| response_text(v, depth + 1)).collect::<Vec<_>>().join("\n")),
        Value::Object(map) => {
            for key in ["output", "content", "text", "result"] {
                if let Some(v) = map.get(key) { return response_text(v, depth + 1); }
            }
            ["stdout", "stderr"].iter().filter_map(|key| map.get(*key))
                .map(|v| response_text(v, depth + 1)).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n")
        }
        _ => String::new(),
    }
}

fn response_failed(value: &Value, depth: usize) -> bool {
    if depth > 6 { return false; }
    match value {
        Value::Object(map) => map.get("is_error").or_else(|| map.get("isError")).and_then(Value::as_bool) == Some(true)
            || ["exit_code", "exitCode"].iter().any(|key| map.get(*key).and_then(Value::as_i64).is_some_and(|code| code != 0))
            || ["output", "content", "text", "result"].iter().any(|key| map.get(*key).is_some_and(|v| response_failed(v, depth + 1))),
        Value::Array(values) => values.iter().take(64).any(|v| response_failed(v, depth + 1)),
        Value::String(s) if s.len() <= 256 * 1024 => {
            let values = transcript_values(s);
            values.iter().any(|v| response_failed(v, depth + 1)) || serde_json::from_str::<Value>(s).ok().is_some_and(|v| response_failed(&v, depth + 1))
        }
        _ => false,
    }
}

fn response_process(value: &Value, depth: usize) -> Option<String> {
    if depth > 6 { return None; }
    if let Some(id) = value.get("session_id").filter(|v| !v.is_null()) {
        return Some(id.as_str().map(str::to_string).unwrap_or_else(|| id.to_string()));
    }
    match value {
        Value::String(s) if s.len() <= 256 * 1024 => transcript_values(s).iter().find_map(|v| response_process(v, depth + 1))
            .or_else(|| serde_json::from_str::<Value>(s).ok().and_then(|v| response_process(&v, depth + 1))),
        Value::Array(values) => values.iter().take(64).find_map(|v| response_process(v, depth + 1)),
        Value::Object(map) => ["output", "content", "text"].iter().filter_map(|key| map.get(*key)).find_map(|v| response_process(v, depth + 1)),
        _ => None,
    }
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
    fn command_outputs_keep_real_failures_content_blocks_and_test_totals() {
        let shell = json!({ "tool_name": "Shell", "tool_input": {"command":"dotnet test"},
            "tool_output": "{\"stdout\":\"FAIL Tests.Todo\",\"stderr\":\"assertion failed\",\"exitCode\":1}" });
        let data = collect(shell.as_object().unwrap(), "/tmp", true);
        assert_eq!(data["terminal"]["failed"], true);
        assert_eq!(data["terminal"]["output"], "FAIL Tests.Todo\nassertion failed");
        let wrapped = json!({ "tool_name": "exec", "tool_response": { "content": [
            {"type":"text", "text":"{\"output\":\"Passed! - Passed: 48\",\"session_id\":77}"} ] } });
        let data = collect(wrapped.as_object().unwrap(), "/tmp", true);
        assert_eq!(data["terminal"]["output"], "Passed! - Passed: 48");
        assert_eq!(data["terminal"]["processId"], "77");
        let transcript = "Script completed\nWall time: 1s\nOutput:\n{\"output\":\"FAIL tests/todo.test.ts\",\"exit_code\":1,\"session_id\":77}";
        assert_eq!(response_text(&json!(transcript), 0), "FAIL tests/todo.test.ts");
        assert!(response_failed(&json!(transcript), 0));
        assert_eq!(response_process(&json!(transcript), 0).as_deref(), Some("77"));
        let long = format!("{}\nTests: 48 passed, 48 total", "line\n".repeat(10_000));
        let text = bounded(&long);
        assert!(text.ends_with("Tests: 48 passed, 48 total"));
        assert!(text.chars().count() <= 16_000);
    }

    #[test]
    fn literal_multi_file_shell_reads_capture_code_without_executing_the_command() {
        let dir = std::env::temp_dir().join(format!("nebulanook-shell-preview-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("one.cs"), "class One {}\n").unwrap();
        std::fs::write(dir.join("two.cs"), "class Two {}\n").unwrap();
        let map = json!({ "tool_name":"Bash", "tool_input":{"command":"cat one.cs; sed -n '1,20p' two.cs"} });
        let data = capture(map.as_object().unwrap(), "PreToolUse", dir.to_str().unwrap()).unwrap();
        assert_eq!(data["files"].as_array().unwrap().len(), 2);
        assert_eq!(data["files"][0]["content"], "class One {}\n");
        assert_eq!(data["files"][1]["content"], "class Two {}\n");
        for command in ["cat $(pwd)/one.cs", "python3 - <<'PY'\ncat one.cs\nPY", "cat one.cs > out"] {
            assert!(literal_read_paths(command).is_empty());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn only_completed_regular_text_files_are_read() {
        let dir = std::env::temp_dir().join(format!("nebulanook-preview-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("notes.md"), "real file\n").unwrap();
        std::fs::write(dir.join("binary"), b"\0binary").unwrap();
        let map = json!({"tool_name":"Read", "tool_input":{"file_path":"notes.md"}}).as_object().unwrap().clone();
        let data = collect(&map, dir.to_str().unwrap(), true);
        assert_eq!(data["files"][0]["content"], "real file\n");
        assert_eq!(capture(&map, "PreToolUse", dir.to_str().unwrap()).unwrap()["files"][0]["content"], "real file\n");
        assert!(collect(&map, dir.to_str().unwrap(), false).get("files").is_none());
        let mut budget = MAX_TEXT;
        assert!(read_preview("binary", dir.to_str().unwrap(), &mut budget).is_none());
        assert!(read_preview(".", dir.to_str().unwrap(), &mut budget).is_none());
        assert!(capture(&map, "PermissionRequest", dir.to_str().unwrap()).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
