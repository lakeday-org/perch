use std::fmt;

use crate::command::Command;
use crate::output::Format;

#[derive(Debug, PartialEq, Eq)]
pub enum ArgsError {
    MissingCommand,
    UnknownCommand(String),
    UnknownFlag(String),
    MissingValue(&'static str),
}

impl fmt::Display for ArgsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ArgsError::MissingCommand => f.write_str("usage: relcheck <outdated|check|bump> [--json] [--allow-pre]"),
            ArgsError::UnknownCommand(name) => write!(f, "no command named {name}"),
            ArgsError::UnknownFlag(flag) => write!(f, "unknown flag {flag}"),
            ArgsError::MissingValue(what) => write!(f, "{what} needs a value"),
        }
    }
}

/// What the command line asked for.
#[derive(Debug, PartialEq, Eq)]
pub struct Args {
    pub command: Command,
    pub format: Format,
    pub allow_pre: bool,
}

impl Args {
    pub fn parse<I, S>(argv: I) -> Result<Args, ArgsError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut words = argv.into_iter().map(|s| s.as_ref().to_string());
        let mut format = Format::Plain;
        let mut allow_pre = false;
        let mut command = None;
        while let Some(word) = words.next() {
            match word.as_str() {
                "--json" => format = Format::Json,
                "--allow-pre" => allow_pre = true,
                flag if flag.starts_with("--") => return Err(ArgsError::UnknownFlag(flag.to_string())),
                "outdated" => command = Some(Command::Outdated),
                "check" => {
                    let req = words.next().ok_or(ArgsError::MissingValue("check"))?;
                    let version = words.next().ok_or(ArgsError::MissingValue("check"))?;
                    command = Some(Command::Check { req, version });
                }
                "bump" => {
                    let version = words.next().ok_or(ArgsError::MissingValue("bump"))?;
                    let kind = words.next().unwrap_or_else(|| "patch".to_string());
                    command = Some(Command::Bump { version, kind });
                }
                other => return Err(ArgsError::UnknownCommand(other.to_string())),
            }
        }
        Ok(Args { command: command.ok_or(ArgsError::MissingCommand)?, format, allow_pre })
    }
}
