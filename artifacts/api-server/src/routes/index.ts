import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";

const router: IRouter = Router();



router.get("/", (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Rate My Campus Wellbeing</title>
</head>
<body>
  <h1>Rate My Campus Wellbeing</h1>
</body>
</html>`);
});

export { supabase };
export default router;
