-- 今日曝光改用「累計差值」：Threads 以美西時間分日，無法直接取「台灣時間今天」。
-- 每天第一次讀取時記下當時的累計值（base_total），之後今日曝光＝目前累計－base_total。
ALTER TABLE account_daily ADD COLUMN base_total INTEGER;
ALTER TABLE account_daily ADD COLUMN cum_total INTEGER;
