//! Semantic versions, prerelease ordering, and the requirements (`^1.2`, `~0.4.1`, `>=1, <2`) that select them.

mod error;
mod prerelease;
mod req;
mod select;
mod version;

pub use crate::error::Error;
pub use crate::prerelease::{Identifier, Prerelease};
pub use crate::req::{Comparator, Op, VersionReq};
pub use crate::select::{max_satisfying, min_satisfying, newest_by_major};
pub use crate::version::Version;
