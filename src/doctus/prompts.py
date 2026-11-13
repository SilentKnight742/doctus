"""Prompts and the structured-output schemas the model must follow."""

from typing import Literal

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


class ExtractedLink(BaseModel):
    kind: Literal["prerequisite", "related"]
    # Only for prerequisite links: "before" = this concept must be understood
    # before the node it attaches to; "after" = it builds on that node.
    direction: Literal["before", "after"] = "before"
    reason: str = Field(default="", max_length=400)


class CoveredConcept(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    summary: str = Field(default="", max_length=400)
    evidence: list[str] = []   # 1-2 quotes; extras are ignored
    link: ExtractedLink | None = None   # link to the current node


class FrontierConcept(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    summary: str = Field(default="", max_length=400)
    attach_to: str = Field(min_length=1, max_length=80)
    link: ExtractedLink


class Extraction(BaseModel):
    current_node_evidence: list[str] = []   # 1-2 quotes; extras are ignored
    covered: list[CoveredConcept] = []
    frontier: list[FrontierConcept] = []


EXTRACT_SYSTEM = """You record what a learner has actually covered in a tutoring chat.
You get the subject, the current concept, the names already on the map, and
a conversation. Messages marked [context] were already processed; take
evidence only from them if it is needed, and focus on the new messages.

Return:
- current_node_evidence: 1-2 quotes showing the current concept itself was
  taught or understood in this conversation; empty if it was not.
- covered: other concepts this conversation actually taught. Each distinct
  rule, contrast, term or pattern the tutor explained (or the learner showed
  they understood) is its own concept, even if it is part of the current
  concept. If the tutor explained it in a reply, it is covered, not frontier.
  For each: a short name, a one-sentence summary, 1-2 evidence quotes, and
  its link to the current concept.
- frontier: concepts that were mentioned or are clearly needed but were NOT
  explored. For each: name, summary, attach_to (the existing or covered
  concept it hangs off, usually the current concept), and the link.

Evidence rules:
- Every quote is copied character for character from one message of the
  conversation: a sentence or clause of at least a few words. Do not
  paraphrase, translate, fix spelling, join pieces or add ellipses.
- Quote the tutor's explanation or a correct learner answer. Never quote a
  learner's question as evidence: asking about something is not learning it.
- A concept that was only mentioned (named, offered as a next step) is
  frontier, not covered.

Concept rules:
- One node per teachable idea; short names.
- Reuse an existing name exactly when it means the same thing.
- Do not list the current concept in covered or frontier.
- At most 3 frontier concepts per attach point; prefer the most useful.

Link rules:
- kind "prerequisite": one concept must be understood before the other.
  direction "before" means the listed concept comes first; "after" means
  the concept it attaches to comes first.
- The reason must say why the earlier concept must come first, and the
  direction must match the reason. If you cannot state such a reason, use
  kind "related".
- kind "related": adjacent ideas with no required order."""


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
teaching them in full. Suggested next topics in the context below are
places the learner could go next; point to them when they come up.

{context}"""
