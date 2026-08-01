WITH all_events AS (
  SELECT COUNT(CASE WHEN is_qa = 1 THEN 1 END) AS qa_rows
  FROM product_events
),
real_funnel AS (
  SELECT
    COUNT(DISTINCT CASE WHEN name = 'visited' THEN session_id END) AS users,
    COUNT(DISTINCT CASE WHEN name = 'room_created' THEN session_id END) AS creators,
    COUNT(DISTINCT CASE WHEN name = 'room_code_copied' THEN session_id END) AS copiers,
    COUNT(DISTINCT CASE WHEN name = 'room_code_copied' THEN room_id END) AS rooms_copied,
    COUNT(DISTINCT CASE WHEN name = 'entry_confirmed' THEN session_id END) AS entrants,
    COUNT(DISTINCT CASE WHEN name = 'entry_confirmed' THEN room_id END) AS rooms_entered,
    COUNT(DISTINCT CASE WHEN name = 'board_filtered' THEN session_id END) AS filters,
    COUNT(DISTINCT CASE WHEN name = 'room_managed' THEN session_id END) AS managers,
    COUNT(DISTINCT CASE WHEN name = 'returned' THEN session_id END) AS returned,
    COUNT(DISTINCT CASE WHEN name = 'room_created' AND created_at >= unixepoch() - 604800 THEN room_id END) AS created_7d,
    COUNT(DISTINCT CASE WHEN name = 'room_code_copied' AND created_at >= unixepoch() - 604800 THEN session_id END) AS copiers_7d
  FROM product_events
  WHERE is_qa = 0
),
live_rooms AS (
  SELECT
    COUNT(CASE WHEN status = 'active' AND expires_at > unixepoch() THEN 1 END) AS active_rooms,
    COUNT(CASE WHEN status = 'full' AND expires_at > unixepoch() THEN 1 END) AS full_rooms,
    COUNT(CASE WHEN status = 'closed' AND expires_at > unixepoch() THEN 1 END) AS closed_rooms,
    COUNT(CASE WHEN status = 'hidden' AND expires_at > unixepoch() THEN 1 END) AS hidden_rooms
  FROM rooms
),
signals AS (
  SELECT
    COUNT(CASE WHEN kind = 'entered' THEN 1 END) AS entered_signals,
    COUNT(CASE WHEN kind = 'full' THEN 1 END) AS full_signals
  FROM room_signals
),
reports AS (
  SELECT COUNT(*) AS reports FROM content_reports
)
SELECT real_funnel.*, all_events.qa_rows, live_rooms.*, signals.*, reports.reports
FROM real_funnel CROSS JOIN all_events CROSS JOIN live_rooms CROSS JOIN signals CROSS JOIN reports;
