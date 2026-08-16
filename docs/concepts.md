# Concepts

Everything in Openworks is a project, an entity hanging off it, a reference
between two of them, or a comment on any of them. Features are views over that
substrate rather than separate systems.

## Projects

A project is the unit of work. It has a slug, a title, a kind, and a phase in
a state machine. There are two kinds:

- **own**: research you are doing. Nineteen states, from `ideation` to
  `poster`.
- **review**: reviewing someone else's. Seven states, from `setup` to `final`.

The phase is validated server-side against the transition table in
`packages/domain/src/fsm.ts`, which is the only copy. It used to be written out
once per consumer, and the copies disagreed about which transitions existed.

## Entities

Eight types, all addressable, all attached to a project:

| Type         | What it holds                                            |
| ------------ | -------------------------------------------------------- |
| `research`   | the project itself                                       |
| `memo`       | a note, a decision, an unresolved question               |
| `experiment` | a run, with a status of planned, running, done or failed |
| `table`      | results, as data rather than as an image of data         |
| `figure`     | a plot, with the artifact it was generated from          |
| `venue`      | a target: a conference, a workshop, a journal            |
| `section`    | a draft section of the paper                             |
| `tex`        | LaTeX source                                             |

Memos, experiments, tables and figures are venue-independent: the same ablation
is the same ablation whichever paper it ends up in. Sections and tex carry an
optional venue, where null means canonical and anything else means scoped to
that submission. `fork_section` and `fork_tex` copy one across.

## References

A reference is a typed edge between two entities: a memo points at the
experiment that settled it, a section points at the table it reports, an
experiment points at the figure drawn from it. The graph is the substrate, and
it is what makes a half-finished piece of work addressable instead of buried.

## Comments

Comments are polymorphic and threaded: any entity can carry one, and a reply is
a comment whose parent is another comment. Each carries an author type of
`user` or `agent` and an author id, so a reviewer agent's objection and a human
peer's objection land in the same thread separated only by a tag.

Deletion is soft. A thread with a hole in it reads as though nothing was ever
said there.

## Events

Four event types fan out to subscribed agents: `entity.created`,
`entity.updated`, `state.transitioned`, `comment.posted`. See
[Agents](/docs/agents/).
