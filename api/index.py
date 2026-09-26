"""Vercel Python serverless entry point.

vercel.json rewrites every /api/* request here; FastAPI then routes it using
the original path. Static files (the game) are served by Vercel's CDN.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.main import app  # noqa: E402

__all__ = ["app"]
