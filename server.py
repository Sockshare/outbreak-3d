#!/usr/bin/env python3
"""
Outbreak 3D — Deadzone Survivor Sim.
Flask server (port 8107). The whole simulation runs in the browser; this only serves the page and its assets.
"""
import argparse
from pathlib import Path
from flask import Flask, jsonify, render_template

BASE_DIR = Path(__file__).resolve().parent
app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
app.config["TEMPLATES_AUTO_RELOAD"] = True


@app.after_request
def no_store(resp):
    # The page and its scripts are never cached, so a reload always shows the current build
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    return resp


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/health")
def health():
    return jsonify({"ok": True, "app": "Outbreak 3D // Deadzone Survivor Sim", "port": 8107})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Outbreak 3D server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8107)
    args = parser.parse_args()
    app.run(host=args.host, port=args.port, debug=False)
