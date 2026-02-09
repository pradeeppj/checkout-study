#!/usr/bin/env python3
"""
Condition C — Agent-selected modality (LLM-only, with plain-English rationale)

- Single flow-level LLM call (stateless) assigns a modality for each step.
- No heuristics, no payload printed.
- Outputs JSONL per step:
  {"step_id": "...", "llm_mode": "...", "rationale": "..."}

Prereqs:
  pip install openai pydantic

Env:
  export OPENAI_API_KEY="..."

Run:
  python decide_modes.py --card_type Physical
  python decide_modes.py --card_type Digital
"""

from __future__ import annotations

import argparse
import json
from typing import Any, Dict, List, Literal

from openai import OpenAI
from pydantic import BaseModel, Field

Mode = Literal["standard", "voice", "chat"]
InputStructure = Literal["select", "numeric", "text", "info"]
ValueType = Literal["integer", "currency", "none"]

# ----------------------------
# System prompt (no "standard fallback" + rationale required)
# ----------------------------
SYSTEM_PROMPT = """You are an interaction modality planner for a checkout flow.

Assign exactly ONE modality to each step:
- standard
- voice
- chat

Critical constraint:
- Do NOT treat any modality as a default or fallback.
- In particular, do NOT choose "standard" simply because it feels safer.
- All three modalities are equally supported and equally safe in this interface.

Interface invariants (parity across modalities):
- Voice and chat inputs are parsed into the same structured fields as standard input.
- The system shows a confirmation preview before continuing for voice/chat.
- Validation is enforced when applicable; invalid values block progress until corrected.
- Users can easily edit/correct the value before proceeding.
- If a step has presets, the user can pick a preset using any modality.

Output requirements:
- Return valid JSON only matching the schema.
- Provide a brief plain-English rationale per step (1–2 sentences).
- Do NOT include the full step payload in the rationale.
- Do NOT ask follow-up questions.
"""

# ----------------------------
# Structured output schema
# ----------------------------
class StepPlan(BaseModel):
    step_id: str
    preferred_mode: Mode
    rationale: str = Field(..., description="Brief 1–2 sentence plain-English justification.")


class FlowPlan(BaseModel):
    plan: List[StepPlan] = Field(..., description="One entry per step.")


# ----------------------------
# Minimal step descriptor (sent to LLM; NOT printed)
# ----------------------------
def step_payload(
    *,
    step_id: str,
    step_title: str,
    step_kind: str,
    input_structure: InputStructure,
    value_type: ValueType = "none",
    options_count: int = 0,
    price_sensitive: bool = False,
    has_validation_guardrails: bool = False,
    has_presets: bool = False,
    preset_count: int = 0,
    parity_supported: bool = True,
) -> Dict[str, Any]:
    return {
        "step_id": step_id,
        "step_title": step_title,
        "step_kind": step_kind,
        "input_structure": input_structure,
        "value_type": value_type,
        "options_count": int(options_count),
        "price_sensitive": bool(price_sensitive),
        "has_validation_guardrails": bool(has_validation_guardrails),
        "has_presets": bool(has_presets),
        "preset_count": int(preset_count),
        "parity_supported": bool(parity_supported),
    }


def build_flow(card_type: Literal["Physical", "Digital"]) -> List[Dict[str, Any]]:
    steps: List[Dict[str, Any]] = [
        step_payload(
            step_id="card_type",
            step_title="Select Card Type",
            step_kind="choice",
            input_structure="select",
            options_count=2,
        ),
        step_payload(
            step_id="variant",
            step_title="Card Variant",
            step_kind="choice",
            input_structure="select",
            options_count=2,
        ),
        step_payload(
            step_id="expiry",
            step_title="Expiry & Pricing",
            step_kind="choice",
            input_structure="select",
            options_count=3,
            price_sensitive=True,
        ),
        step_payload(
            step_id="design",
            step_title="Choose a Design",
            step_kind="design",
            input_structure="select",
            options_count=20,
        ),
        step_payload(
            step_id="activation",
            step_title="Delivery & Activation",
            step_kind="choice",
            input_structure="select",
            options_count=4,
        ),
        step_payload(
            step_id="packaging",
            step_title="Packaging",
            step_kind="choice",
            input_structure="select",
            options_count=3,
            price_sensitive=True,
        ),
        # Recipient subpages
        step_payload(
            step_id="r1_qty",
            step_title="Recipient: Quantity",
            step_kind="number",
            input_structure="numeric",
            value_type="integer",
            has_validation_guardrails=True,
            has_presets=True,
            preset_count=5,
        ),
        step_payload(
            step_id="r1_amt",
            step_title="Recipient: Gift amount",
            step_kind="amount",
            input_structure="numeric",
            value_type="currency",
            price_sensitive=True,
            has_validation_guardrails=True,
            has_presets=True,
            preset_count=6,
        ),
        step_payload(
            step_id="r1_msg",
            step_title="Recipient: Gift message (optional)",
            step_kind="text",
            input_structure="text",
        ),
    ]

    if card_type == "Digital":
        steps += [
            step_payload(
                step_id="digital_delivery",
                step_title="Digital Delivery Method",
                step_kind="choice",
                input_structure="select",
                options_count=2,
            ),
            step_payload(
                step_id="digital_identifier",
                step_title="Delivery Identifier",
                step_kind="info",
                input_structure="info",
            ),
        ]
    else:
        steps += [
            step_payload(
                step_id="shipping_method",
                step_title="Shipping Method",
                step_kind="choice",
                input_structure="select",
                options_count=2,
                price_sensitive=True,
            ),
            step_payload(
                step_id="shipping_address",
                step_title="Shipping Address",
                step_kind="info",
                input_structure="info",
            ),
        ]

    steps.append(
        step_payload(
            step_id="payment",
            step_title="Payment Method",
            step_kind="choice",
            input_structure="select",
            options_count=2,
        )
    )

    return steps


# ----------------------------
# One-shot flow-level decision
# ----------------------------
def decide_flow_plan(client: OpenAI, steps: List[Dict[str, Any]], *, model: str) -> FlowPlan:
    resp = client.responses.parse(
        model=model,
        input=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps({"steps": steps}, ensure_ascii=False)},
        ],
        text_format=FlowPlan,
    )
    return resp.output_parsed


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--card_type", choices=["Physical", "Digital"], default="Physical")
    ap.add_argument("--model", default="gpt-5.2")
    args = ap.parse_args()

    steps = build_flow(args.card_type)

    client = OpenAI()
    plan = decide_flow_plan(client, steps, model=args.model)

    # Print JSONL in flow order (no payloads)
    plan_map = {p.step_id: p for p in plan.plan}
    for s in steps:
        p = plan_map.get(s["step_id"])
        if not p:
            # Should not happen, but keep output stable
            out = {"step_id": s["step_id"], "llm_mode": "standard", "rationale": "No decision returned for this step."}
        else:
            # out = {"step_id": p.step_id, "llm_mode": p.preferred_mode, "rationale": p.rationale}
            out = {"step_id": p.step_id, "llm_mode": p.preferred_mode}
        print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
