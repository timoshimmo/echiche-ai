from datetime import UTC, datetime, timedelta

from echiche_worker.memory import DecisionItem, MemoryItem, context_json, select_context, sensitivity

NOW = datetime(2026, 10, 28, tzinfo=UTC)


def mem(i: int, kind: str, content: str, days_ago: int = 0) -> MemoryItem:
    return MemoryItem(f"m{i}", kind, content, NOW - timedelta(days=days_ago), "user", False, 1)


def test_decision_first_then_strategy_then_relevant_items_only() -> None:
    memories = [
        mem(1, "goal", "Reach 20 paying clinics by June.", 10),
        mem(2, "constraint", "Two engineers until March.", 5),
        mem(3, "assumption", "Clinics pay 80 dollars monthly for scheduling.", 3),
        mem(4, "fact", "The office moved to Ikeja.", 1),
    ]
    decision = DecisionItem("d1", 2, "Pilot model?", "Paid pilot.", "Tests willingness to pay.", "medium", NOW)
    chosen = select_context(memories, decision, "What monthly price for scheduling?")
    assert [c.ref for c in chosen] == ["D1", "M1", "M2", "M3"]
    assert [c.memory_id for c in chosen[1:]] == ["m2", "m1", "m3"]  # strategy newest first, then relevant
    assert "version 2" in chosen[0].content and "Paid pilot." in chosen[0].content


def test_no_memory_and_irrelevant_memory_produce_no_recall() -> None:
    assert select_context([], None, "Anything?") == []
    assert context_json([]) == "[]"
    chosen = select_context([mem(1, "fact", "The office moved to Ikeja.")], None, "Should we raise prices?")
    assert chosen == []


def test_caps_on_items_and_characters() -> None:
    many = [mem(i, "goal", f"Goal number {i} " + "x" * 300, i) for i in range(40)]
    chosen = select_context(many, None, "q", max_items=20, max_chars=3000)
    assert len(chosen) <= 20 and sum(len(c.content) for c in chosen) <= 3000


def test_context_json_marks_items_as_remembered_with_dates() -> None:
    chosen = select_context([mem(1, "goal", "Reach 20 clinics.", 30)], None, "q")
    payload = context_json(chosen)
    assert '"remembered": "Reach 20 clinics."' in payload and '"recorded_on": "2026-09-28"' in payload


def test_sensitive_proposals_are_flagged() -> None:
    assert sensitivity("The founder's salary must be covered by June.") == "sensitive"
    assert sensitivity("A diagnosis delayed the launch.") == "sensitive"
    assert sensitivity("Run a paid pilot with three clinics.") == "normal"


def test_small_projects_can_still_recall_a_distinctive_fact() -> None:
    # M7 benchmark case M05: with one remembered fact every word is in "all" items, so plain IDF
    # never reached the threshold. A word unique to one item now counts as distinctive.
    lease = mem(1, "fact", "The Accra office lease ends in March.")
    picked = select_context([lease], None, "The Accra lease was extended; should we hire locally?")
    assert [c.content for c in picked] == [lease.content]
    assert select_context([lease], None, "Should we start a podcast?") == []
