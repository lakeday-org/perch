//! The relcheck command as a library: read a lockfile and a registry index, say which pins a newer release would satisfy.

pub mod args;
pub mod command;
pub mod lockfile;
pub mod output;

pub use crate::args::{Args, ArgsError};
pub use crate::command::{run, Command};
pub use crate::lockfile::{Lockfile, Pin};
pub use crate::output::{Json, Plain, Render, Row};
