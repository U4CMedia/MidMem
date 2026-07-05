# PATCH.md — live-core insertion for finalize_turn

Insert immediately before `return result` at the end of `finalize_turn`
(`agent/turn_finalizer.py`), as a fail-open single call:

```python
    try:
        from agent.midmem_workcapture import record_turn
        record_turn(final_response=final_response, interrupted=interrupted, messages=messages,
                    turn_id=turn_id, task_id=effective_task_id,
                    session_id=getattr(agent, "session_id", "") or "")
    except Exception:
        pass
    return result
```

(Variables `final_response`, `interrupted`, `messages`, `turn_id`, `effective_task_id`, `agent` are all
in scope there — verified.) The module file goes to `~/.hermes/hermes-agent/agent/midmem_workcapture.py`.
