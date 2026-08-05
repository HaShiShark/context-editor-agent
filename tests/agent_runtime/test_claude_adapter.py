from __future__ import annotations

import pytest

from agent_runtime.adapters.base import ProviderRequestContext
from agent_runtime.adapters.claude_adapter import ClaudeAdapter
from agent_runtime.core.stream_events import ProviderDoneEvent, ToolCallReadyEvent
from app_agent.session_agent import SessionAgent


def test_build_request_converts_input_image_data_url_to_claude_image_block() -> None:
    adapter = ClaudeAdapter(client=object())

    request = adapter.build_request(
        ProviderRequestContext(
            model="claude-sonnet-4-5",
            current_turn=(
                {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "Describe this."},
                        {
                            "type": "input_image",
                            "image_url": "data:image/png;base64,aGVsbG8=",
                            "detail": "auto",
                        },
                    ],
                },
            ),
        )
    )

    content = request["messages"][0]["content"]
    assert content[0] == {"type": "text", "text": "Describe this."}
    assert content[1] == {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": "aGVsbG8=",
        },
    }


def test_build_request_converts_image_url_part_to_claude_url_image_block() -> None:
    adapter = ClaudeAdapter(client=object())

    request = adapter.build_request(
        ProviderRequestContext(
            model="claude-opus-4-7",
            current_turn=(
                {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": "https://example.com/image.webp",
                            },
                        },
                    ],
                },
            ),
        )
    )

    assert request["messages"][0]["content"] == [
        {
            "type": "image",
            "source": {
                "type": "url",
                "url": "https://example.com/image.webp",
            },
        }
    ]


def test_claude_agent_allows_image_content_parts_before_adapter_translation() -> None:
    agent = SessionAgent.__new__(SessionAgent)
    agent.provider_type = "claude"

    agent._assert_supported_content_parts(
        [
            {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "Look at this."},
                    {"type": "input_image", "image_url": "data:image/jpeg;base64,abc"},
                ],
            }
        ]
    )


def test_claude_agent_allows_preserved_thinking_and_tool_use_parts() -> None:
    agent = SessionAgent.__new__(SessionAgent)
    agent.provider_type = "claude"

    agent._assert_supported_content_parts(
        [
            {
                "type": "message",
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "x", "signature": "sig"},
                    {
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "read_file",
                        "input": {"path": "README.md"},
                    },
                ],
            }
        ]
    )


def test_claude_rejects_unsupported_image_media_types() -> None:
    adapter = ClaudeAdapter(client=object())

    with pytest.raises(ValueError, match="Claude image input supports"):
        adapter.build_request(
            ProviderRequestContext(
                model="claude-sonnet-4-5",
                current_turn=(
                    {
                        "type": "message",
                        "role": "user",
                        "content": [
                            {
                                "type": "input_image",
                                "image_url": "data:image/svg+xml;base64,PHN2Zy8+",
                            },
                        ],
                    },
                ),
            )
        )


def test_build_request_preserves_claude_thinking_blocks_before_tool_result() -> None:
    adapter = ClaudeAdapter(client=object())

    request = adapter.build_request(
        ProviderRequestContext(
            model="claude-sonnet-4-5",
            current_turn=(
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "thinking",
                            "thinking": "Need to inspect the file.",
                            "signature": "signed-thinking",
                        },
                        {
                            "type": "tool_use",
                            "id": "toolu_1",
                            "name": "read_file",
                            "input": {"path": "README.md"},
                        },
                    ],
                },
                {
                    "type": "function_call_output",
                    "call_id": "toolu_1",
                    "output": "contents",
                },
            ),
        )
    )

    assert request["messages"] == [
        {
            "role": "assistant",
            "content": [
                {
                    "type": "thinking",
                    "thinking": "Need to inspect the file.",
                    "signature": "signed-thinking",
                },
                {
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "read_file",
                    "input": {"path": "README.md"},
                },
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_1",
                    "content": "contents",
                }
            ],
        },
    ]


def test_stream_response_canonical_items_include_thinking_signature_and_tool_use() -> None:
    adapter = ClaudeAdapter(client=object())

    events = list(
        adapter._stream_events(
            [
                {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "thinking", "thinking": ""},
                },
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "thinking_delta", "thinking": "Use the tool."},
                },
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "signature_delta", "signature": "sig"},
                },
                {"type": "content_block_stop", "index": 0},
                {
                    "type": "content_block_start",
                    "index": 1,
                    "content_block": {
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "read_file",
                        "input": {},
                    },
                },
                {
                    "type": "content_block_delta",
                    "index": 1,
                    "delta": {
                        "type": "input_json_delta",
                        "partial_json": '{"path":"README.md"}',
                    },
                },
                {"type": "content_block_stop", "index": 1},
                {"type": "message_stop"},
            ]
        )
    )

    assert any(isinstance(event, ToolCallReadyEvent) for event in events)
    done = next(event for event in events if isinstance(event, ProviderDoneEvent))

    assert done.canonical_items == (
        {
            "type": "message",
            "role": "assistant",
            "content": [
                {
                    "type": "thinking",
                    "thinking": "Use the tool.",
                    "signature": "sig",
                },
                {
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "read_file",
                    "input": {"path": "README.md"},
                },
            ],
        },
    )


