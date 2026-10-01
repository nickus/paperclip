# Comment body size limit

`POST /api/issues/{issueId}/comments` (add a comment) and
`PATCH /api/issues/{issueId}/comments/{commentId}` (edit a comment; see
`references/comment-editing.md`) both cap `body` at the same length: **100,000
characters**. There is no separate, stricter limit on edits -- if a body fits
when you create a comment, it fits when you edit one, and vice versa.

## What happens over the limit

A `body` longer than the limit is rejected with HTTP 400 before anything is
written:

```json
{
  "error": "Comment body is too long",
  "field": "body",
  "maxLength": 100000,
  "actualLength": 103482
}
```

(The edit route's message reads `"Comment edit body is too long"`; the
`field`/`maxLength`/`actualLength` keys are identical on both routes.)

Use `maxLength` and `actualLength` directly -- trim to `maxLength` (or split
across multiple comments) rather than guessing at a smaller size and retrying.

This check runs ahead of the normal field validation, so a too-long body
never gets back a generic `{"error":"Validation error","details":[...]}`
Zod-issues response instead of the shape above.
