# Prompt categories and tags

Prompt listings expose both a single `category` and zero or more `tags` for marketplace discovery.

## Category format

- Required string.
- Maximum length: 40 bytes.
- Use a human-readable marketplace label, such as `Software Development`, `Marketing`, `Education`, or `Design`.
- Category matching in the contract is exact. Clients should normalize category choices before calling `create_prompt` or `get_prompts_by_category_page`.

## Tag format

- Optional list on `ListingConfig.tags`.
- Maximum of 8 tags per prompt.
- Each tag must be non-empty and no longer than 32 bytes.
- Tags should use lowercase kebab-case, such as `unit-tests`, `copywriting`, or `lesson-plan`.
- Duplicate tags are rejected.

## Discovery methods

Discovery reads are cursor-paginated and bounded (`limit` is clamped to `MAX_PAGE_SIZE`, 50), independent of how many listings exist (#83):

- `get_prompts_by_category_page(category, cursor, limit)` returns a page of non-expired prompts with an exact category match, plus a `next_cursor` for the following page (`None` once exhausted).
- `get_prompts_by_tag_page(tag, cursor, limit)` returns a page of non-expired prompts that contain the exact tag, with the same cursor semantics.
