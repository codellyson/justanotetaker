-- Conversational role for agent sessions: null / "user" = a note the person
-- wrote; "assistant" = a reply written by an agent (via the MCP reply tool).
-- Lets a board act as a two-way thread. Existing notes stay null (i.e. user).
ALTER TABLE `notes` ADD `role` text;
