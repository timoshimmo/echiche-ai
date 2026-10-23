"""Worker entry point.

M1: validates configuration and exits. The job loop (claim with FOR UPDATE SKIP LOCKED,
lease/heartbeat, stage execution) is implemented in M3.

Exit codes: 0 = configuration valid, 2 = configuration invalid.
"""

from __future__ import annotations

import os
import sys

from echiche_worker import __version__
from echiche_worker.config import ConfigError, parse_worker_config
from echiche_worker.log import log


def main() -> int:
    try:
        config = parse_worker_config(os.environ)
    except ConfigError as error:
        log("error", "config_invalid", issues=error.issues)
        return 2
    log(
        "info",
        "worker_skeleton_ready",
        version=__version__,
        worker_id=config.worker_id,
        note="No job loop until M3; exiting.",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
