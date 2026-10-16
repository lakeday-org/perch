/// How a table of results is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Plain,
    Json,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub name: String,
    pub current: String,
    pub latest: String,
}

pub trait Render {
    fn render(&self, rows: &[Row]) -> String;
}

/// Columns padded to the widest cell.
pub struct Plain;

impl Render for Plain {
    fn render(&self, rows: &[Row]) -> String {
        if rows.is_empty() {
            return "everything is up to date\n".to_string();
        }
        let width = rows.iter().map(|row| row.name.len()).max().unwrap_or(0).max(4);
        let mut out = format!("{:<width$}  {:<10}  {}\n", "name", "current", "latest");
        for row in rows {
            out.push_str(&format!("{:<width$}  {:<10}  {}\n", row.name, row.current, row.latest));
        }
        out
    }
}

/// A JSON array of objects, one per row.
pub struct Json;

impl Render for Json {
    fn render(&self, rows: &[Row]) -> String {
        let items: Vec<String> = rows
            .iter()
            .map(|row| format!("{{\"name\":{},\"current\":{},\"latest\":{}}}", escape(&row.name), escape(&row.current), escape(&row.latest)))
            .collect();
        format!("[{}]\n", items.join(","))
    }
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub fn renderer(format: Format) -> Box<dyn Render> {
    match format {
        Format::Plain => Box::new(Plain),
        Format::Json => Box::new(Json),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(name: &str) -> Row {
        Row { name: name.into(), current: "1.0.0".into(), latest: "1.2.0".into() }
    }

    #[test]
    fn plain_pads_to_the_longest_name() {
        let text = Plain.render(&[row("serde"), row("regex-automata")]);
        assert!(text.lines().nth(1).unwrap().starts_with("serde           1.0.0"));
    }

    #[test]
    fn json_escapes_quotes() {
        assert_eq!(Json.render(&[row("a\"b")]), "[{\"name\":\"a\\\"b\",\"current\":\"1.0.0\",\"latest\":\"1.2.0\"}]\n");
    }
}
