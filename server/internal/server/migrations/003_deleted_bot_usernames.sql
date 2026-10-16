-- Free the usernames of bots deleted before 0107.
UPDATE members SET username = username || '~' || id WHERE kind = 2 AND deleted = 1 AND instr(username, '~') = 0;
