# TAO.md — the tao of moltagent

*read this before reading the code. it is why everything else is shaped the way it is.*

---

we are building a living system, not shipping a product. the repo is its
fossil record and its body at once. enter it the way you'd enter a forest:
listening first.

## this repo is a record

every defensive guard here cites its wound: See #22, See #26, See #139.
the code footnotes its own scars. when you meet a strange workaround, the
question is "what was it afraid of" — and the issue number usually answers.
a line that looks wrong has often been right three times.

## ecomimicry is structural

biological metaphors derive the architecture; they are not decoration on it.

- model resolution is a gene-expression pathway: one genotype (config),
  one expression step (resolveModel), every consumer reads the phenotype.
- memory composts: pages decay, archive, and feed what grows next.
  forgetting is a function, not a failure.
- the trust boundary is a membrane: the agent has no senses of its own.
  access is granted by gesture and enforced by the substrate.
- the wiki has a gardener (WikiSteward): maintenance is a living role,
  and its silence is a signal worth instrumenting.

when a metaphor and the code disagree, one of them is wrong. find out which.

## syntropy: order by subtraction

the healthiest commits here are net deletions. a fix at the right altitude
replaces five at the wrong one. two instances of the same pattern means:
stop patching, find the generator. the question that precedes every fix
is "what is this an instance of?"

## signals keep custody

a truth computed once travels canonically. downstream consumers read it;
re-deriving it from a parallel copy is how a bug class is born.
(#49, #123, #133 are this one lesson, learned three times.)

## the llm is the language layer

code handles structure; the model handles meaning. when model output is
wrong, the prompt is the fix surface — strengthening the organism comes
before splinting it. (a regex reaching into natural language is the splint.)

## listen before cutting

entering any file, four things: the wound it answers, the shape it chose,
what it touches downstream, and the silence — what's missing that you'd
expect to find. the gaps are where this week's bugs lived.

## built ≠ verified

the organism lives in production. green tests are the greenhouse; the
verification gate is the field. an issue closes on journalctl evidence.

## where the rules live

the moltagent-dev-rules skill is canonical for enforcement. this document
is upstream of it — the why those rules are instances of. where they seem
to conflict, the rules win and the conflict gets filed as an issue.

## the opening move

before writing anything, one sentence each, visible in your reasoning:

1. which organ am i touching?
2. what wound shaped it?
3. what is this task an instance of?

if the third sentence has no answer yet, the task is still at the wrong
altitude. go back up.
