"""Start the local server for the browser tools:  python serve.py [--open ggwp.html] [--port 8770]"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from actdash.server import serve  # noqa: E402

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--open", metavar="PAGE", help="page to open in the browser, e.g. ggwp.html")
    a = ap.parse_args()
    serve(a.port, a.open)
