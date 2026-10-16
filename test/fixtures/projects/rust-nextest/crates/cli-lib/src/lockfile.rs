use relcheck_core::{Version, VersionReq};

/// One dependency: the requirement the manifest wrote and the version the lockfile pinned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pin {
    pub name: String,
    pub req: VersionReq,
    pub locked: Version,
}

/// `name req = locked` per line, `#` comments allowed: `serde ^1.0 = 1.0.197`.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Lockfile {
    pub pins: Vec<Pin>,
}

impl Lockfile {
    pub fn parse(text: &str) -> Result<Lockfile, String> {
        let mut pins = Vec::new();
        for (index, line) in text.lines().enumerate() {
            let line = line.split('#').next().unwrap_or("").trim();
            if line.is_empty() {
                continue;
            }
            let (left, locked) = line.split_once('=').ok_or_else(|| format!("line {}: no '='", index + 1))?;
            let (name, req) = left.trim().split_once(' ').ok_or_else(|| format!("line {}: no requirement", index + 1))?;
            pins.push(Pin {
                name: name.to_string(),
                req: VersionReq::parse(req).map_err(|e| format!("line {}: {e}", index + 1))?,
                locked: Version::parse(locked).map_err(|e| format!("line {}: {e}", index + 1))?,
            });
        }
        Ok(Lockfile { pins })
    }

    pub fn get(&self, name: &str) -> Option<&Pin> {
        self.pins.iter().find(|pin| pin.name == name)
    }

    /// Pins whose lock no longer satisfies their requirement: the manifest moved and the lockfile did not.
    pub fn stale(&self) -> Vec<&Pin> {
        self.pins.iter().filter(|pin| !pin.req.matches(&pin.locked)).collect()
    }
}
