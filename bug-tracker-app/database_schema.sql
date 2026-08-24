CREATE TABLE scans (
  id text PRIMARY KEY,
  source text NOT NULL,
  files text[] NOT NULL,
  created_at bigint NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL
);

CREATE TABLE bugs (
  id text PRIMARY KEY,
  scan_id text REFERENCES scans(id) ON DELETE CASCADE NOT NULL,
  file text NOT NULL,
  line integer,
  severity text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  status text NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL
);

-- Enable Row Level Security (RLS)
ALTER TABLE scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE bugs ENABLE ROW LEVEL SECURITY;

-- Create policies so users can only access their own data
CREATE POLICY "Users can manage their own scans" ON scans
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own bugs" ON bugs
  FOR ALL USING (auth.uid() = user_id);
