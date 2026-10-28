import { Router } from "express";
import multer from "multer";
import { Store } from "./store.js";
import { saveDocument, getFile, filePath } from "./documents.js";
import { AppError } from "./errors.js";
export function fileRoutes(store: Store) {
  const router = Router();
  router.post(
    "/files",
    (req, res, next) => {
      const prefs = store.setting<{ maxFileMB: number }>("preferences")!;
      multer({
        storage: multer.memoryStorage(),
        limits: {
          files: 1,
          fileSize: prefs.maxFileMB * 1024 * 1024,
          fields: 5,
        },
      }).single("file")(req, res, next);
    },
    async (req, res) => {
      if (!req.file)
        throw new AppError(400, "Attach a document using the file form field.");
      res
        .status(201)
        .json(
          await saveDocument(store, req.file.originalname, req.file.buffer),
        );
    },
  );
  router.get("/files/:id", (req, res) =>
    res.json(getFile(store, String(req.params.id))),
  );
  router.get("/files/:id/content", (req, res) => {
    const file = getFile(store, String(req.params.id));
    res.type(file.mime);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="document.${file.format}"`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(filePath(store, file.id));
  });
  return router;
}
