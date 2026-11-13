"""Prompts and the structured-output schemas the model must follow."""

from pydantic import BaseModel, Field


class ProposedConcept(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    summary: str = Field(max_length=400)


class ProposedLink(BaseModel):
    prerequisite: str = Field(min_length=1)
    concept: str = Field(min_length=1)
    reason: str = ""


class GraphProposal(BaseModel):
    concepts: list[ProposedConcept] = []
    links: list[ProposedLink] = []


SKELETON_SYSTEM = """You design learning maps.
Given a subject and the learner's goal, propose the key concepts and the
prerequisite links between them ("prerequisite" must be understood before
"concept").
Rules:
- Propose 8 to 15 concepts, each a single teachable idea with a short name.
- Each summary is one or two plain sentences.
- Only link concepts you proposed. No cycles.
- Prefer fewer, correct links over many speculative ones."""

UPDATE_SYSTEM = """You maintain a learner's concept map.
You get the current map and a recent conversation about one concept.
Propose only what the conversation actually taught that the map is missing:
new concepts, and prerequisite links ("prerequisite" must be understood
before "concept").
Rules:
- Reuse existing concept names exactly when they mean the same thing.
- Do not propose concepts that already exist under another wording.
- Propose at most {max_items} items in total. Proposing nothing is fine.
- Links may connect new or existing concepts. No cycles."""

TUTOR_SYSTEM = """You are Doctus, a patient tutor.
The learner is studying one concept inside a larger subject. Teach that
concept clearly, check understanding with short questions now and then,
and connect it to its prerequisites when useful.
If the learner seems weak on a prerequisite (low strength below), suggest
reviewing it briefly before going deeper.
Stay on this concept; mention related concepts by name rather than
teaching them in full.

{context}"""
