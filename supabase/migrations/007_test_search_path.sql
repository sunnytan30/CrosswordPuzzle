-- Pin the test harness's search_path too, so the linter stays clean and the
-- suite cannot be steered by a caller's search_path.
alter function test.run_all() set search_path = '';
