"""test_midmem_workcapture — acceptance + unit tests for the Hermes core capture module.

Run from this directory (integrations/hermes-workcapture/):
     python3 -m unittest test_midmem_workcapture -v
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest

# Make the module importable — it sits beside this test file.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import midmem_workcapture as mc


# ---------------------------------------------------------------------------
# Suite-wide prod-safety guard: point MIDMEM_DB_PATH at a throwaway temp db for
# the ENTIRE run so that ANY real emit (e.g. fail-open tests that don't mock
# Popen) can never touch the production state.db. Individual tests that need a
# specific db (the real-integration test) override MIDMEM_DB_PATH themselves.
# ---------------------------------------------------------------------------
_SUITE_TMP_DB = None
_SUITE_TMP_DIR = None
_SUITE_OLD_DB = None


def setUpModule():
    global _SUITE_TMP_DB, _SUITE_TMP_DIR, _SUITE_OLD_DB
    _SUITE_OLD_DB = os.environ.get("MIDMEM_DB_PATH")
    # mkdtemp (not the insecure mktemp) — a private 0700 dir, unpredictable name.
    _SUITE_TMP_DIR = tempfile.mkdtemp(prefix="midmem-suite-")
    _SUITE_TMP_DB = os.path.join(_SUITE_TMP_DIR, "suite.db")
    os.environ["MIDMEM_DB_PATH"] = _SUITE_TMP_DB


def tearDownModule():
    if _SUITE_OLD_DB is not None:
        os.environ["MIDMEM_DB_PATH"] = _SUITE_OLD_DB
    else:
        os.environ.pop("MIDMEM_DB_PATH", None)
    try:
        if _SUITE_TMP_DIR and os.path.isdir(_SUITE_TMP_DIR):
            shutil.rmtree(_SUITE_TMP_DIR, ignore_errors=True)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class _FakePopen:
    """Capture argv+env without spawning."""

    def __init__(self, *args, **kwargs):
        self.argv = args
        self.kwargs = kwargs
        self.returncode = 0

    def __enter__(self):
        return self

    def __exit__(self, *a):
        pass


def _capture_popen():
    """Return (original, captured_list) — caller must restore."""
    original = subprocess.Popen
    captured = []

    def fake(*args, **kwargs):
        captured.append({"args": args, "kwargs": kwargs})
        return _FakePopen(*args, **kwargs)

    subprocess.Popen = fake
    return original, captured


def _restore_popen(original):
    subprocess.Popen = original


def _make_turn(**kw):
    """Convenience: default turn with final_response set."""
    defaults = dict(
        final_response="test response",
        interrupted=False,
        messages=[{"role": "user", "content": "hello"}, {"role": "assistant", "content": "test response"}],
        turn_id="t1",
        task_id="",
        session_id="s1",
    )
    defaults.update(kw)
    return defaults


# ---------------------------------------------------------------------------
# Test 1: record_turn never raises — junk / None / empty / malformed
# ---------------------------------------------------------------------------

class TestNeverRaises(unittest.TestCase):

    def _call(self, **kw):
        turn = _make_turn(**kw)
        mc.record_turn(**turn)

    def test_junk_final_response(self):
        self._call(final_response=42, messages="not a list")

    def test_none_final_response(self):
        self._call(final_response=None, messages=None)

    def test_empty_messages(self):
        self._call(messages=[])

    def test_malformed_message_dict(self):
        self._call(messages=[{"role": "user", "content": 123}, {"content": "no role"}])

    def test_content_as_list_of_dicts(self):
        self._call(messages=[{"role": "assistant", "content": [{"text": "hello"}]}])

    def test_all_params_none(self):
        mc.record_turn(
            final_response=None,
            interrupted=None,
            messages=None,
            turn_id=None,
            task_id=None,
            session_id=None,
        )


# ---------------------------------------------------------------------------
# Test 2: text-ending turn → one Popen, --kind decision, --scope hermes
# ---------------------------------------------------------------------------

class TestTextEnding(unittest.TestCase):

    def test_text_ending(self):
        orig, captured = _capture_popen()
        try:
            mc.record_turn(
                final_response="hello world",
                interrupted=False,
                messages=[{"role": "user", "content": "hi"}],
                turn_id="t1",
                task_id="",
                session_id="s1",
            )
            self.assertEqual(len(captured), 1)
            argv = captured[0]["args"][0]
            self.assertIn("--kind", argv)
            kind_idx = argv.index("--kind")
            self.assertEqual(argv[kind_idx + 1], "decision")
            self.assertIn("--scope", argv)
            scope_idx = argv.index("--scope")
            self.assertEqual(argv[scope_idx + 1], "hermes")
        finally:
            _restore_popen(orig)


# ---------------------------------------------------------------------------
# Test 3: tool-ending turn (final_response="", messages has tool result)
# → one Popen, --kind task_attempt  (THE case the plugin misses)
# ---------------------------------------------------------------------------

class TestToolEnding(unittest.TestCase):

    def test_tool_ending_records(self):
        orig, captured = _capture_popen()
        try:
            mc.record_turn(
                final_response="",
                interrupted=False,
                messages=[
                    {"role": "user", "content": "do something"},
                    {"role": "assistant", "content": "I'll do that.", "tool_calls": [
                        {"name": "write_file", "arguments": {"path": "output.txt"}}
                    ]},
                    {"role": "tool", "content": "File written"},
                ],
                turn_id="t3",
                task_id="",
                session_id="s1",
            )
            self.assertEqual(len(captured), 1)
            argv = captured[0]["args"][0]
            kind_idx = argv.index("--kind")
            self.assertEqual(argv[kind_idx + 1], "task_attempt")
        finally:
            _restore_popen(orig)


# ---------------------------------------------------------------------------
# Test 4: dead_end — messages/response contain "Traceback … error"
# ---------------------------------------------------------------------------

class TestDeadEnd(unittest.TestCase):

    def test_dead_end(self):
        orig, captured = _capture_popen()
        try:
            mc.record_turn(
                final_response="Traceback (most recent call last)\nError: file not found",
                interrupted=False,
                messages=[{"role": "tool", "content": "Error: permission denied"}],
                turn_id="t4",
                task_id="",
                session_id="s1",
            )
            self.assertEqual(len(captured), 1)
            argv = captured[0]["args"][0]
            kind_idx = argv.index("--kind")
            self.assertEqual(argv[kind_idx + 1], "dead_end")
        finally:
            _restore_popen(orig)


# ---------------------------------------------------------------------------
# Test 5: artifact — path /home/duck/x.md or URL present, no error words
# ---------------------------------------------------------------------------

class TestArtifact(unittest.TestCase):

    def test_artifact_path(self):
        orig, captured = _capture_popen()
        try:
            mc.record_turn(
                final_response="Saved to /home/duck/x.md",
                interrupted=False,
                messages=[{"role": "assistant", "content": "done"}],
                turn_id="t5",
                task_id="",
                session_id="s1",
            )
            self.assertEqual(len(captured), 1)
            argv = captured[0]["args"][0]
            kind_idx = argv.index("--kind")
            self.assertEqual(argv[kind_idx + 1], "artifact")
        finally:
            _restore_popen(orig)

    def test_artifact_url(self):
        orig, captured = _capture_popen()
        try:
            mc.record_turn(
                final_response="Result: https://example.com/output.png",
                interrupted=False,
                messages=[{"role": "assistant", "content": "done"}],
                turn_id="t5b",
                task_id="",
                session_id="s1",
            )
            self.assertEqual(len(captured), 1)
            argv = captured[0]["args"][0]
            kind_idx = argv.index("--kind")
            self.assertEqual(argv[kind_idx + 1], "artifact")
        finally:
            _restore_popen(orig)


# ---------------------------------------------------------------------------
# Test 6: truly-empty turn → no Popen
# ---------------------------------------------------------------------------

class TestEmptyTurn(unittest.TestCase):

    def test_empty_turn_skipped(self):
        orig, captured = _capture_popen()
        try:
            mc.record_turn(
                final_response="",
                interrupted=False,
                messages=[],
                turn_id="t6",
                task_id="",
                session_id="s1",
            )
            self.assertEqual(len(captured), 0)
        finally:
            _restore_popen(orig)


# ---------------------------------------------------------------------------
# Test 7: kill switch MIDMEM_HERMES_CAPTURE_DISABLED=1 → no Popen
# ---------------------------------------------------------------------------

class TestKillSwitch(unittest.TestCase):

    def test_kill_switch(self):
        orig, captured = _capture_popen()
        try:
            os.environ["MIDMEM_HERMES_CAPTURE_DISABLED"] = "1"
            try:
                mc.record_turn(
                    final_response="x" * 500,
                    interrupted=False,
                    messages=[{"role": "assistant", "content": "x" * 500}],
                    turn_id="t7",
                    task_id="",
                    session_id="s1",
                )
                self.assertEqual(len(captured), 0)
            finally:
                del os.environ["MIDMEM_HERMES_CAPTURE_DISABLED"]
        finally:
            _restore_popen(orig)


# ---------------------------------------------------------------------------
# Test 8: emit env contract — captured env has MIDMEM_AGENT_SCOPE=hermes
# AND MIDMEM_LLM_ENABLED=0
# ---------------------------------------------------------------------------

class TestEmitEnv(unittest.TestCase):

    def test_env_contract(self):
        orig, captured = _capture_popen()
        try:
            mc.record_turn(
                final_response="hello",
                interrupted=False,
                messages=[{"role": "assistant", "content": "hello"}],
                turn_id="t8",
                task_id="",
                session_id="s1",
            )
            self.assertEqual(len(captured), 1)
            env = captured[0]["kwargs"]["env"]
            self.assertEqual(env.get("MIDMEM_AGENT_SCOPE"), "hermes")
            self.assertEqual(env.get("MIDMEM_LLM_ENABLED"), "0")
        finally:
            _restore_popen(orig)


# ---------------------------------------------------------------------------
# Test 9: Popen forced to raise → record_turn still returns (fail-open)
# ---------------------------------------------------------------------------

class TestFailOpen(unittest.TestCase):

    def test_fail_open(self):
        orig = subprocess.Popen

        def raise_popen(*args, **kwargs):
            raise RuntimeError("simulated Popen failure")

        subprocess.Popen = raise_popen
        try:
            # Should NOT raise
            mc.record_turn(
                final_response="hello",
                interrupted=False,
                messages=[{"role": "assistant", "content": "hello"}],
                turn_id="t9",
                task_id="",
                session_id="s1",
            )
        except Exception:
            self.fail("record_turn raised — should be fail-open")
        finally:
            subprocess.Popen = orig


# ---------------------------------------------------------------------------
# Test 10: debounce — two same-task turns → one Popen; after reset /
# different task → spawns again
# ---------------------------------------------------------------------------

class TestDebounce(unittest.TestCase):

    def test_debounce_same_task(self):
        # Set debounce to 30s
        old = os.environ.get("MIDMEM_HERMES_CAPTURE_DEBOUNCE_S")
        os.environ["MIDMEM_HERMES_CAPTURE_DEBOUNCE_S"] = "30"
        mc._reset_debounce()
        orig, captured = _capture_popen()
        try:
            mc.record_turn(
                final_response="first",
                interrupted=False,
                messages=[{"role": "assistant", "content": "first"}],
                turn_id="t10a",
                task_id="same-task",
                session_id="s1",
            )
            mc.record_turn(
                final_response="second",
                interrupted=False,
                messages=[{"role": "assistant", "content": "second"}],
                turn_id="t10b",
                task_id="same-task",
                session_id="s1",
            )
            self.assertEqual(len(captured), 1)
        finally:
            _restore_popen(orig)
            if old is not None:
                os.environ["MIDMEM_HERMES_CAPTURE_DEBOUNCE_S"] = old
            else:
                del os.environ["MIDMEM_HERMES_CAPTURE_DEBOUNCE_S"]

    def test_debounce_different_task(self):
        os.environ["MIDMEM_HERMES_CAPTURE_DEBOUNCE_S"] = "30"
        mc._reset_debounce()
        orig, captured = _capture_popen()
        try:
            mc.record_turn(
                final_response="first",
                interrupted=False,
                messages=[{"role": "assistant", "content": "first"}],
                turn_id="t10c",
                task_id="task-a",
                session_id="s1",
            )
            mc.record_turn(
                final_response="second",
                interrupted=False,
                messages=[{"role": "assistant", "content": "second"}],
                turn_id="t10d",
                task_id="task-b",
                session_id="s1",
            )
            self.assertEqual(len(captured), 2)
        finally:
            _restore_popen(orig)
            del os.environ["MIDMEM_HERMES_CAPTURE_DEBOUNCE_S"]


# ---------------------------------------------------------------------------
# Test 11: real-midmem integration (skip if hook.mjs absent)
# ---------------------------------------------------------------------------

class TestRealMidmemIntegration(unittest.TestCase):

    def test_real_hook_mjs(self):
        """Fresh temp MIDMEM_DB_PATH, real record_turn on tool-ending turn,
        wait, sqlite3 read → 1 row, scope='hermes', distinctive token."""
        import sqlite3

        # Create fresh temp db in a secure temp dir (mkdtemp, not insecure mktemp).
        tmpdb = os.path.join(tempfile.mkdtemp(prefix="midmem-emit-"), "emit.db")

        # _emit reads MIDMEM_DB_PATH at CALL time — redirect the emit to the
        # temp db via env so the real spawn NEVER touches prod state.db.
        old_db = os.environ.get("MIDMEM_DB_PATH")
        os.environ["MIDMEM_DB_PATH"] = tmpdb

        # Also disable debounce for this test
        old_debounce = os.environ.get("MIDMEM_HERMES_CAPTURE_DEBOUNCE_S")
        os.environ["MIDMEM_HERMES_CAPTURE_DEBOUNCE_S"] = "0"

        try:
            mc.record_turn(
                final_response="",
                interrupted=False,
                messages=[
                    {"role": "user", "content": "do it"},
                    {"role": "assistant", "content": "done", "tool_calls": [
                        {"name": "write_file", "arguments": {"path": "/tmp/test.md"}}
                    ]},
                    {"role": "tool", "content": "File written"},
                ],
                turn_id="t11",
                task_id="real-integration-task",
                session_id="s11",
            )

            # Wait for detached subprocess to finish (hook.mjs init + write)
            time.sleep(8.0)

            # Read the db directly — Orchestrator writes to 'entries' table
            conn = sqlite3.connect(tmpdb)
            try:
                cur = conn.execute(
                    "SELECT COUNT(*) FROM entries WHERE scope = 'hermes'"
                )
                count = cur.fetchone()[0]
                self.assertGreaterEqual(count, 1, "Expected >= 1 scope=hermes row in temp db")

                # Check distinctive token
                cur = conn.execute(
                    "SELECT content FROM entries WHERE scope = 'hermes' LIMIT 1"
                )
                row = cur.fetchone()
                self.assertIsNotNone(row)
                self.assertIn("hermes:acp:", row[0])
            finally:
                conn.close()
        finally:
            if old_db is not None:
                os.environ["MIDMEM_DB_PATH"] = old_db
            else:
                os.environ.pop("MIDMEM_DB_PATH", None)
            if old_debounce is not None:
                os.environ["MIDMEM_HERMES_CAPTURE_DEBOUNCE_S"] = old_debounce
            else:
                del os.environ["MIDMEM_HERMES_CAPTURE_DEBOUNCE_S"]
            # Clean up temp db
            if os.path.exists(tmpdb):
                os.unlink(tmpdb)


# ---------------------------------------------------------------------------
# Helper tests: derive_kind, collapse_ws
# ---------------------------------------------------------------------------

class TestDeriveKind(unittest.TestCase):

    def test_decision(self):
        self.assertEqual(mc.derive_kind("hello world", ""), "decision")

    def test_dead_end_requires_tool_error(self):
        # dead_end comes from a STRUCTURED tool error, not prose.
        self.assertEqual(mc.derive_kind("anything", "", tool_error=True), "dead_end")

    def test_prose_error_word_is_not_dead_end(self):
        # An error WORD in normal prose must NOT be dead_end (the tuning).
        self.assertEqual(mc.derive_kind("Error: file not found", ""), "decision")
        self.assertEqual(mc.derive_kind("Traceback appears in the docs", ""), "decision")
        self.assertEqual(mc.derive_kind("Operation denied per policy", ""), "decision")

    def test_prose_error_tool_only_is_task_attempt(self):
        self.assertEqual(mc.derive_kind("", "checked for errors, none found"), "task_attempt")

    def test_artifact_path(self):
        self.assertEqual(mc.derive_kind("/home/duck/x.md", ""), "artifact")

    def test_artifact_url(self):
        self.assertEqual(mc.derive_kind("https://example.com", ""), "artifact")

    def test_task_attempt_empty(self):
        self.assertEqual(mc.derive_kind("", ""), "task_attempt")

    def test_task_attempt_tool_only(self):
        self.assertEqual(mc.derive_kind("", "tool:write_file"), "task_attempt")


class TestToolErrorDetection(unittest.TestCase):
    """_has_tool_error: structured signals only, never prose."""

    def test_structured_success_false(self):
        self.assertTrue(mc._has_tool_error(
            [{"role": "tool", "content": '{"success": false, "error": "boom"}'}]))

    def test_structured_error_key(self):
        self.assertTrue(mc._has_tool_error(
            [{"role": "tool", "content": '{"error": "kaboom"}'}]))

    def test_tool_result_starts_error(self):
        self.assertTrue(mc._has_tool_error([{"role": "tool", "content": "Error: denied"}]))

    def test_is_error_flag(self):
        self.assertTrue(mc._has_tool_error([{"role": "tool", "is_error": True, "content": "x"}]))

    def test_prose_error_word_not_tool_error(self):
        # error word only in ASSISTANT prose -> not a tool error
        self.assertFalse(mc._has_tool_error(
            [{"role": "assistant", "content": "I hit an error earlier but fixed it"}]))

    def test_clean_tool_result_not_error(self):
        self.assertFalse(mc._has_tool_error(
            [{"role": "tool", "content": "optionA-live-verify"},
             {"role": "assistant", "content": "Done. exit code 0"}]))

    def test_success_shapes_are_not_error(self):
        # These are SUCCESS shapes — must NOT be flagged (the #385 regression).
        for body in ('{"error": false}', '{"success": true, "error": false}',
                     '{"error": null}', '{"error": ""}', '{"success": true}',
                     '{"ok": true, "output": "kindtune-check-ok"}'):
            self.assertFalse(mc._has_tool_error([{"role": "tool", "content": body}]),
                             f"false positive on: {body}")

    def test_hostile_input_no_raise(self):
        for bad in (None, 42, [1, 2, {"role": None}], [{"role": "tool", "content": 99}]):
            self.assertFalse(mc._has_tool_error(bad))


class TestKindTuning(unittest.TestCase):
    """End-to-end: record_turn derives the right kind via record path."""

    def test_prose_error_records_as_decision_not_dead_end(self):
        # The turn #380 failure mode: benign summary with an error word, clean tools.
        orig, captured = _capture_popen()
        try:
            mc.record_turn(
                final_response="Task done: ran echo, exit code 0, no errors, called kanban_complete",
                interrupted=False,
                messages=[{"role": "tool", "content": "optionA-live-verify"}],
                turn_id="tt", session_id="s1",
            )
            argv = captured[0]["args"][0]
            self.assertEqual(argv[argv.index("--kind") + 1], "decision")
        finally:
            _restore_popen(orig)

    def test_structured_tool_error_records_dead_end(self):
        orig, captured = _capture_popen()
        try:
            mc.record_turn(
                final_response="I tried to write the file",
                interrupted=False,
                messages=[{"role": "tool", "content": '{"success": false, "error": "permission denied"}'}],
                turn_id="tt", session_id="s1",
            )
            argv = captured[0]["args"][0]
            self.assertEqual(argv[argv.index("--kind") + 1], "dead_end")
        finally:
            _restore_popen(orig)


class TestCollapseWs(unittest.TestCase):

    def test_collapse(self):
        self.assertEqual(mc.collapse_ws("  hello   world  "), "hello world")

    def test_collapse_newlines(self):
        self.assertEqual(mc.collapse_ws("hello\n\nworld"), "hello world")

    def test_collapse_none(self):
        self.assertEqual(mc.collapse_ws(None), "")


if __name__ == "__main__":
    unittest.main()
