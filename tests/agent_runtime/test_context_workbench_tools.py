from __future__ import annotations

import json

from web_server_modules.context_workbench import ContextWorkbenchDraft, ContextWorkbenchToolRegistry


def make_transcript() -> list[dict[str, object]]:
    return [
        {
            "role": "user",
            "text": "Please analyze the failing import.",
            "attachments": [],
            "toolEvents": [],
            "blocks": [{"kind": "text", "text": "Please analyze the failing import."}],
            "providerItems": [
                {
                    "type": "message",
                    "role": "user",
                    "content": "Please analyze the failing import.",
                }
            ],
        },
        {
            "role": "assistant",
            "text": "Long tool output that should be summarized.",
            "attachments": [],
            "toolEvents": [],
            "blocks": [{"kind": "text", "text": "Long tool output that should be summarized."}],
            "providerItems": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": "Long tool output that should be summarized.",
                },
                {
                    "type": "function_call",
                    "call_id": "call-1",
                    "name": "shell",
                    "arguments": '{"command":"rg import"}',
                },
                {
                    "type": "function_call_output",
                    "call_id": "call-1",
                    "output": "verbose output",
                },
            ],
        },
        {
            "role": "user",
            "text": "Keep the final decision.",
            "attachments": [],
            "toolEvents": [],
            "blocks": [{"kind": "text", "text": "Keep the final decision."}],
            "providerItems": [
                {
                    "type": "message",
                    "role": "user",
                    "content": "Keep the final decision.",
                }
            ],
        },
    ]


def decode_tool_output(output_text: str) -> dict[str, object]:
    decoded = json.loads(output_text)
    assert isinstance(decoded, dict)
    return decoded


def transcript_texts(draft: ContextWorkbenchDraft) -> list[str]:
    return [str(record.get("text") or "") for record in draft.committed_transcript()]


def test_tool_catalog_only_exposes_the_three_current_tools() -> None:
    tool_ids = [item["id"] for item in ContextWorkbenchToolRegistry.tool_catalog()]
    registry = ContextWorkbenchToolRegistry(ContextWorkbenchDraft(make_transcript(), selected_indexes=[]))

    assert tool_ids == ["get_nodes", "write_nodes", "write_items"]
    assert [schema["name"] for schema in registry.schemas] == tool_ids


def test_write_nodes_can_replace_non_contiguous_nodes_with_stable_anchors() -> None:
    draft = ContextWorkbenchDraft(make_transcript(), selected_indexes=[])
    registry = ContextWorkbenchToolRegistry(draft, "Import failure")

    result = decode_tool_output(
        registry.execute(
            "write_nodes",
            {
                "delete": [1, 3],
                "inserts": [
                    {
                        "after": 1,
                        "role": "user",
                        "content": "Consolidated request and final decision.",
                    }
                ],
            },
        ).output_text
    )

    assert result["result"] == {
        "summary": "Delete #1, 3, Insert 1 node(s)",
        "deleted": [1, 3],
        "inserted": 1,
    }
    assert "updated_snapshot" in result
    assert transcript_texts(draft) == [
        "Consolidated request and final decision.",
        "Long tool output that should be summarized.",
    ]


def test_write_nodes_rejects_missing_delete_targets() -> None:
    draft = ContextWorkbenchDraft(make_transcript(), selected_indexes=[])
    registry = ContextWorkbenchToolRegistry(draft)

    execution = registry.execute("write_nodes", {"delete": [9], "inserts": []})
    result = decode_tool_output(execution.output_text)

    assert execution.status == "error"
    assert "do not exist" in str(result["error"])
    assert len(draft.committed_transcript()) == 3


def test_write_items_requires_fresh_node_details_and_preserves_item_anchors() -> None:
    draft = ContextWorkbenchDraft(make_transcript(), selected_indexes=[])
    registry = ContextWorkbenchToolRegistry(draft)

    rejected = registry.execute(
        "write_items",
        {
            "node_number": 2,
            "delete": [2, 3],
            "inserts": [{"after": 3, "content": "Tool call and output summarized."}],
        },
    )
    assert rejected.status == "error"
    assert "call get_nodes" in str(decode_tool_output(rejected.output_text)["error"])

    details = decode_tool_output(
        registry.execute("get_nodes", {"node_numbers": [2]}).output_text
    )
    assert len(details["nodes"][0]["items"]) == 3

    edited = decode_tool_output(
        registry.execute(
            "write_items",
            {
                "node_number": 2,
                "delete": [2, 3],
                "inserts": [{"after": 3, "content": "Tool call and output summarized."}],
            },
        ).output_text
    )
    assert edited["items_deleted"] == 2
    assert edited["items_inserted"] == 1
    provider_items = draft.committed_transcript()[1]["providerItems"]
    assert [item["type"] for item in provider_items] == ["message", "message"]
    assert provider_items[1]["content"] == "Tool call and output summarized."

    stale_edit = registry.execute(
        "write_items",
        {"node_number": 2, "delete": [2], "inserts": []},
    )
    assert stale_edit.status == "error"
    assert "call get_nodes" in str(decode_tool_output(stale_edit.output_text)["error"])


def test_review_mode_allows_one_rationalized_node_proposal() -> None:
    draft = ContextWorkbenchDraft(make_transcript(), selected_indexes=[])
    registry = ContextWorkbenchToolRegistry(draft, "Import failure", review_mode=True)

    assert [schema["name"] for schema in registry.schemas] == ["write_nodes"]
    assert registry.schemas[0]["parameters"]["required"] == ["review_rationale"]

    missing_rationale = registry.execute(
        "write_nodes",
        {"delete": [1], "inserts": []},
    )
    assert missing_rationale.status == "error"
    assert not draft.has_changes

    first = registry.execute(
        "write_nodes",
        {
            "delete": [1, 3],
            "inserts": [
                {
                    "after": 1,
                    "role": "user",
                    "content": "Consolidated request and final decision.",
                }
            ],
            "review_rationale": "合并重复需求，同时保留当前结论。",
        },
    )
    assert first.status == "completed"
    assert draft.revision_summary() == "合并重复需求，同时保留当前结论。"

    second = registry.execute(
        "write_nodes",
        {
            "delete": [2],
            "inserts": [],
            "review_rationale": "再删除一次。",
        },
    )
    assert second.status == "error"
    assert "exactly one" in str(decode_tool_output(second.output_text)["error"])
