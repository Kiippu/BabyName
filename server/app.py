"""Flask app factory. CO-4 §3: gates every /api/* route by default through a
single before_request allowlist, so a route added later is protected unless
someone deliberately opens it here -- requireUser is gone, there's exactly
one mechanism now.
"""

import os

from flask import Flask, g, jsonify, request, send_from_directory

import list as list_module  # module name matches list.js; aliased to avoid shadowing the builtin
import names
import rounds
import themes
from db import get_db, init_app as init_db_app
from detail import get_name_detail
from gate import bp as gate_bp
from identity import SESSION_COOKIE, cookie_kwargs, me_payload, resolve_session, touch_session
from settings import get_settings, update_settings
from stats import get_stats

CLIENT_DIST = os.path.join(os.path.dirname(__file__), "..", "client", "dist")

# CO-4 §3 asks for a strict two-path allowlist (POST /api/gate, GET
# /api/health). GET /api/me is added here as a deliberate deviation -- see
# the comment below. Everything else under /api/ requires a valid session.
ALLOWLIST = {
    ("POST", "/api/gate"),
    ("GET", "/api/health"),
    # client/src/App.tsx calls api.getMe() on mount with no .catch(). mePayload
    # already answers "nobody's signed in" as data (claimed: false), exactly
    # like the old sessionMiddleware did for req.session.userId == null --
    # it was never an error case. Gating this route would turn that first
    # call into a 401, the unhandled promise rejection would leave `me`
    # stuck at `undefined`, and the app would render a permanent blank
    # screen instead of the PIN screen. It exposes nothing beyond "is
    # someone signed in", which the payload always exposed.
    ("GET", "/api/me"),
}


def create_app():
    app = Flask(__name__)
    init_db_app(app)
    app.register_blueprint(gate_bp)

    @app.before_request
    def gate_check():
        if not request.path.startswith("/api/"):
            return None
        if (request.method, request.path) in ALLOWLIST:
            return None
        conn = get_db()
        token = request.cookies.get(SESSION_COOKIE)
        session = resolve_session(conn, token)
        if not session:
            return jsonify({"error": "not signed in"}), 401
        g.user_id = session["userId"]
        g.session_token = token
        return None

    @app.after_request
    def slide_session(response):
        # Slides the expiry forward on every authenticated request, mirroring
        # identity.js's sessionMiddleware. Skipped for /api/gate itself,
        # which sets its own fresh cookie on success.
        token = getattr(g, "session_token", None)
        if token:
            conn = get_db()
            touch_session(conn, token)
            response.set_cookie(SESSION_COOKIE, token, **cookie_kwargs())
        return response

    @app.errorhandler(rounds.ApiError)
    def handle_api_error(err):
        return jsonify({"error": str(err)}), err.status

    @app.get("/api/health")
    def health():
        return jsonify({"ok": True})

    @app.get("/api/me")
    def me():
        conn = get_db()
        token = request.cookies.get(SESSION_COOKIE)
        session = resolve_session(conn, token)
        user_id = session["userId"] if session else None
        resp = jsonify(me_payload(conn, user_id))
        if session:
            touch_session(conn, token)
            resp.set_cookie(SESSION_COOKIE, token, **cookie_kwargs())
        return resp

    @app.get("/api/round")
    def get_round():
        return jsonify(rounds.round_payload(get_db(), g.user_id))

    @app.post("/api/set")
    def post_set():
        body = request.get_json(silent=True) or {}
        try:
            round_id = int(body.get("roundId"))
        except (TypeError, ValueError):
            round_id = None
        set_index = body.get("setIndex")
        kept_ids_raw = body.get("keptIds")
        kept_ids = [int(x) for x in kept_ids_raw] if isinstance(kept_ids_raw, list) else None
        if not round_id or not isinstance(set_index, int) or isinstance(set_index, bool) or set_index < 0 or kept_ids is None:
            return jsonify({"error": "roundId, setIndex, and keptIds are required"}), 400

        result = rounds.lock_set(get_db(), g.user_id, round_id, set_index, kept_ids)
        if result["sealed"]:
            return jsonify({"sealed": True})
        return jsonify({"nextSet": rounds.round_payload(get_db(), g.user_id)})

    @app.get("/api/round/<int:round_id>/result")
    def get_round_result(round_id):
        return jsonify(rounds.get_round_result(get_db(), g.user_id, round_id))

    @app.post("/api/round/<int:round_id>/ack")
    def post_round_ack(round_id):
        return jsonify(rounds.ack_round(get_db(), g.user_id, round_id))

    @app.post("/api/names")
    def post_names():
        body = request.get_json(silent=True) or {}
        name = body.get("name").strip() if isinstance(body.get("name"), str) else ""
        note = body.get("note").strip() if isinstance(body.get("note"), str) else ""
        if not name:
            return jsonify({"error": "name is required"}), 400
        result = names.add_name(get_db(), g.user_id, name, note)
        if not result["ok"]:
            return jsonify({"error": result["error"]}), 400
        return jsonify(result["row"])

    @app.get("/api/names/<int:name_id>")
    def get_name(name_id):
        detail = get_name_detail(get_db(), name_id, g.user_id)
        if not detail:
            return jsonify({"error": "not found"}), 404
        return jsonify(detail)

    @app.get("/api/list")
    def get_list():
        tab = "out" if request.args.get("tab") == "out" else "in"
        return jsonify(list_module.get_list(get_db(), tab))

    @app.get("/api/stats")
    def get_stats_route():
        return jsonify(get_stats(get_db()))

    @app.get("/api/settings")
    def get_settings_route():
        return jsonify(get_settings(get_db()))

    @app.put("/api/settings")
    def put_settings():
        body = request.get_json(silent=True) or {}
        father, mother, baby_surname = body.get("father"), body.get("mother"), body.get("babySurname")

        def valid_person(p):
            return isinstance(p, dict) and isinstance(p.get("name"), str) and isinstance(p.get("surname"), str)

        if not valid_person(father) or not valid_person(mother) or not isinstance(baby_surname, str):
            return jsonify({"error": "father, mother, and babySurname are required"}), 400
        try:
            return jsonify(update_settings(get_db(), father, mother, baby_surname))
        except ValueError as err:
            return jsonify({"error": str(err)}), 400

    @app.get("/api/themes")
    def get_themes():
        return jsonify(themes.get_themes_tree(get_db()))

    @app.put("/api/themes/<int:theme_id>")
    def put_theme(theme_id):
        body = request.get_json(silent=True) or {}
        if not isinstance(body.get("enabled"), bool):
            return jsonify({"error": "enabled must be a boolean"}), 400
        if not themes.set_theme_enabled(get_db(), theme_id, body["enabled"]):
            return jsonify({"error": "not found"}), 404
        return jsonify(themes.get_themes_tree(get_db()))

    @app.route("/", defaults={"path": ""})
    @app.route("/<path:path>")
    def spa(path):
        # CO-4 §7: nginx serves /assets/ and /icons/ directly in production,
        # bypassing Python entirely -- this route only matters in dev, same
        # as index.js's express.static + catch-all did.
        if path.startswith("api/"):
            return jsonify({"error": "not found"}), 404
        full_path = os.path.join(CLIENT_DIST, path) if path else None
        if path and os.path.isfile(full_path):
            return send_from_directory(CLIENT_DIST, path)
        return send_from_directory(CLIENT_DIST, "index.html")

    return app


if __name__ == "__main__":
    create_app().run(debug=True)
