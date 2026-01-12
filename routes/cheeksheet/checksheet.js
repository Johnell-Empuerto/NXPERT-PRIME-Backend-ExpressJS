const express = require("express");
const router = express.Router();
const pool = require("../../db");

// Helper function: Detect schema changes
const detectSchemaChanges = (oldFields, newFields) => {
  const changes = [];

  // Convert old fields to map for easy lookup
  const oldFieldMap = {};
  oldFields.forEach((field) => {
    oldFieldMap[field.instance_id] = field;
  });

  // Check each new field
  Object.keys(newFields).forEach((fieldId) => {
    const oldField = oldFieldMap[fieldId];
    const newField = newFields[fieldId];

    if (oldField && oldField.field_type !== newField.type) {
      changes.push({
        fieldId,
        fieldName: newField.field_name || fieldId,
        oldType: oldField.field_type,
        newType: newField.type,
        breakingChange: isBreakingChange(oldField.field_type, newField.type),
      });
    }
  });

  return changes;
};

// Helper function: Check if change is breaking
const isBreakingChange = (oldType, newType) => {
  const breakingPairs = [
    ["text", "number"],
    ["text", "date"],
    ["text", "datetime"],
    ["text", "time"],
    ["text", "boolean"],
    ["textbox", "number"],
    ["textbox", "date"],
    ["number", "text"],
    ["number", "textbox"],
    ["date", "text"],
    ["datetime", "text"],
    ["boolean", "text"],
    ["calculation", "text"],
  ];

  return breakingPairs.some(([from, to]) => from === oldType && to === newType);
};

// Helper function: Create optimized table with proper data types
const createOptimizedTable = async (client, tableName, fieldConfigs) => {
  const columns = [];

  // Always include metadata columns
  columns.push("id SERIAL PRIMARY KEY");
  columns.push("user_id INTEGER");
  columns.push("submitted_at TIMESTAMP DEFAULT NOW()");
  columns.push("template_version INTEGER DEFAULT 1");
  columns.push("original_submission_id INTEGER");

  // Add columns based on field types
  Object.values(fieldConfigs).forEach((config) => {
    const safeName = (config.field_name || config.instanceId)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/_{2,}/g, "_")
      .replace(/^_+|_+$/g, "");

    let columnType = "TEXT";

    switch (config.type) {
      case "number":
      case "calculation":
        columnType = "DECIMAL(12,4)";
        break;
      case "date":
        columnType = "DATE";
        break;
      case "datetime":
        columnType = "TIMESTAMP";
        break;
      case "time":
        columnType = "TIME";
        break;
      case "boolean":
        columnType = "BOOLEAN";
        break;
      default:
        columnType = "TEXT";
    }

    columns.push(`"${safeName}" ${columnType}`);
  });

  const createSQL = `CREATE TABLE "${tableName}" (${columns.join(", ")})`;
  await client.query(createSQL);

  // Create indexes
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_${tableName.replace(/[^a-z0-9]/g, "_")}_user 
    ON "${tableName}" (user_id);
    
    CREATE INDEX IF NOT EXISTS idx_${tableName.replace(/[^a-z0-9]/g, "_")}_date 
    ON "${tableName}" (submitted_at DESC);
    
    CREATE INDEX IF NOT EXISTS idx_${tableName.replace(
      /[^a-z0-9]/g,
      "_"
    )}_version 
    ON "${tableName}" (template_version);
  `);
};

// Helper function: Migrate non-breaking data
// Helper function: Migrate non-breaking data WITH TYPE CHECKING
const migrateNonBreakingData = async (
  client,
  oldTableName,
  newTableName,
  changes,
  version
) => {
  try {
    // Get all columns from old table WITH THEIR TYPES
    const oldColumnsRes = await client.query(
      `
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = $1
      ORDER BY ordinal_position
    `,
      [oldTableName]
    );

    if (oldColumnsRes.rows.length === 0) return 0;

    // Get all columns from new table WITH THEIR TYPES
    const newColumnsRes = await client.query(
      `
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = $1
      ORDER BY ordinal_position
    `,
      [newTableName]
    );

    if (newColumnsRes.rows.length === 0) return 0;

    // Create maps for quick lookup
    const oldColumnsMap = {};
    oldColumnsRes.rows.forEach((row) => {
      oldColumnsMap[row.column_name] = row.data_type;
    });

    const newColumnsMap = {};
    newColumnsRes.rows.forEach((row) => {
      newColumnsMap[row.column_name] = row.data_type;
    });

    // Filter out breaking changes fields
    const breakingFields = changes
      .filter((c) => c.breakingChange)
      .map((c) => c.fieldName.toLowerCase().replace(/[^a-z0-9_]/g, "_"));

    // Get columns that can be migrated (non-breaking AND compatible types)
    const migratableColumns = [];
    const selectExpressions = [];

    oldColumnsRes.rows.forEach((row) => {
      const columnName = row.column_name;
      const oldType = row.data_type;

      // Skip system columns and breaking changes
      if (
        [
          "id",
          "user_id",
          "submitted_at",
          "template_version",
          "original_submission_id",
        ].includes(columnName)
      ) {
        return;
      }

      if (breakingFields.some((bf) => bf === columnName.toLowerCase())) {
        return;
      }

      // Check if column exists in new table
      if (!newColumnsMap[columnName]) {
        console.log(`Skipping ${columnName}: not in new table`);
        return;
      }

      const newType = newColumnsMap[columnName];

      // Check type compatibility
      if (!areTypesCompatible(oldType, newType)) {
        console.log(
          `Skipping ${columnName}: type mismatch (${oldType} -> ${newType})`
        );
        return;
      }

      migratableColumns.push(columnName);

      // Handle type conversions in SELECT
      if (oldType === "date" && newType.includes("character")) {
        // DATE -> TEXT
        selectExpressions.push(
          `TO_CHAR("${columnName}", 'YYYY-MM-DD') as "${columnName}"`
        );
      } else if (
        oldType.includes("timestamp") &&
        newType.includes("character")
      ) {
        // TIMESTAMP -> TEXT
        selectExpressions.push(
          `TO_CHAR("${columnName}", 'YYYY-MM-DD HH24:MI:SS') as "${columnName}"`
        );
      } else if (oldType === "boolean" && newType.includes("character")) {
        // BOOLEAN -> TEXT
        selectExpressions.push(
          `CASE WHEN "${columnName}" = true THEN 'true' WHEN "${columnName}" = false THEN 'false' ELSE NULL END as "${columnName}"`
        );
      } else if (oldType.includes("character") && newType === "date") {
        // TEXT -> DATE (if format matches)
        selectExpressions.push(
          `CASE WHEN "${columnName}" ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN TO_DATE("${columnName}", 'YYYY-MM-DD') ELSE NULL END as "${columnName}"`
        );
      } else {
        // Compatible types
        selectExpressions.push(`"${columnName}"`);
      }
    });

    if (migratableColumns.length === 0) {
      console.log("No migratable columns found");
      return 0;
    }

    // Migrate data (limit to last 1000 submissions for performance)
    const migrateQuery = `
      INSERT INTO "${newTableName}" 
      (user_id, submitted_at, template_version, original_submission_id, ${migratableColumns
        .map((c) => `"${c}"`)
        .join(", ")})
      SELECT 
        user_id, 
        submitted_at, 
        ${version} as template_version, 
        id as original_submission_id,
        ${selectExpressions.join(", ")}
      FROM "${oldTableName}"
      ORDER BY submitted_at DESC
      LIMIT 1000
    `;

    console.log("Migration query executing...");
    const result = await client.query(migrateQuery);
    console.log(
      `Migrated ${result.rowCount} records from ${oldTableName} to ${newTableName}`
    );
    return result.rowCount;
  } catch (err) {
    console.warn(
      `Migration failed from ${oldTableName} to ${newTableName}:`,
      err.message
    );
    return 0;
  }
};

// Helper function to check type compatibility
const areTypesCompatible = (oldType, newType) => {
  // Simplify type comparison
  const oldSimple = simplifyType(oldType);
  const newSimple = simplifyType(newType);

  // Compatible if same type or TEXT can accept anything
  if (newSimple === "text") return true;
  if (oldSimple === newSimple) return true;

  // Some specific compatibilities
  if (oldSimple === "integer" && newSimple === "decimal") return true;
  if (oldSimple === "decimal" && newSimple === "integer") return true;

  return false;
};

const simplifyType = (type) => {
  if (type.includes("character") || type.includes("text")) return "text";
  if (type.includes("integer")) return "integer";
  if (type.includes("decimal") || type.includes("numeric")) return "decimal";
  if (type.includes("date")) return "date";
  if (type.includes("timestamp")) return "timestamp";
  if (type.includes("time")) return "time";
  if (type.includes("boolean")) return "boolean";
  return type;
};

// ==============================
// PUBLISH FORM TEMPLATE WITH PROPER IMAGE POSITIONS
// ==============================
router.post("/templates", async (req, res) => {
  const {
    name,
    html_content,
    original_html_content,
    field_configurations,
    field_positions,
    sheets,
    form_values,
    css_content = "",
    images = {},
    access_control,
  } = req.body;

  if (!name) {
    return res.status(400).json({
      success: false,
      message: "Form name is required",
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    console.log("=== PUBLISHING FORM ===");
    console.log("Form name:", name);
    console.log("Images count:", Object.keys(images).length);
    console.log("Sheets count:", sheets?.length || 1);

    // 1. Insert template with version 1
    const templateRes = await client.query(
      `
      INSERT INTO checksheet_templates 
      (name, html_content, field_configurations, field_positions, 
       sheets, css_content, original_html_content, access_control,
       version, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, true)  
      RETURNING id
      `,
      [
        name,
        html_content || "",
        field_configurations ? JSON.stringify(field_configurations) : null,
        field_positions ? JSON.stringify(field_positions) : null,
        sheets ? JSON.stringify(sheets) : null,
        css_content || "",
        original_html_content || "",
        access_control ? JSON.stringify(access_control) : null,
      ]
    );

    const templateId = templateRes.rows[0].id;
    console.log("Template created with ID:", templateId);

    // 2. ANALYZE IMAGE POSITIONS IN HTML
    const imagePositions = [];

    if (html_content) {
      const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
      let match;
      let index = 0;

      while ((match = imgRegex.exec(html_content)) !== null) {
        const fullTag = match[0];
        const src = match[1];

        let filename = "";
        if (src.includes("IMAGE_PLACEHOLDER:")) {
          filename = src.split("IMAGE_PLACEHOLDER:")[1].replace(/["']/g, "");
        } else {
          filename = src.split("/").pop().split("?")[0];
        }

        imagePositions.push({
          position: index,
          originalSrc: src,
          filename: filename,
          fullTag: fullTag,
        });

        index++;
      }
    }

    // 3. Save images with position information
    const savedImages = {};
    if (images && Object.keys(images).length > 0) {
      const imageEntries = Object.entries(images);

      imageEntries.sort((a, b) => {
        const posA = a[1].position !== undefined ? a[1].position : a[1].order;
        const posB = b[1].position !== undefined ? b[1].position : b[1].order;
        return posA - posB;
      });

      const usedPositions = new Set();

      for (let i = 0; i < imageEntries.length; i++) {
        const [originalPath, imageData] = imageEntries[i];

        try {
          let positionIndex =
            imageData.position !== undefined ? imageData.position : i;

          if (usedPositions.has(positionIndex)) {
            let newPos = positionIndex;
            while (usedPositions.has(newPos)) {
              newPos++;
            }
            positionIndex = newPos;
          }

          usedPositions.add(positionIndex);

          let originalSrc = "";
          if (imageData.originalSrc) {
            originalSrc = imageData.originalSrc;
          } else {
            const simpleFilename = originalPath.includes("/")
              ? originalPath.split("/").pop()
              : originalPath;
            const matchingPosition = imagePositions.find(
              (pos) => pos.filename === simpleFilename
            );
            if (matchingPosition) {
              originalSrc = matchingPosition.originalSrc;
            }
          }

          const elementId = `img_${templateId}_${positionIndex}_${Date.now()}`;

          const imageRes = await client.query(
            `
            INSERT INTO template_images 
            (template_id, original_path, filename, mime_type, image_data, size, 
             position_index, original_src, element_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id
            `,
            [
              templateId,
              originalPath,
              imageData.filename,
              imageData.mimeType,
              imageData.base64,
              imageData.size,
              positionIndex,
              originalSrc,
              elementId,
            ]
          );

          const imageId = imageRes.rows[0].id;
          savedImages[originalPath] = {
            id: imageId,
            position: positionIndex,
            elementId: elementId,
            filename: imageData.filename,
          };
        } catch (imgErr) {
          console.error(`Failed to save image ${originalPath}:`, imgErr);
        }
      }
    }

    // 4. Update HTML to replace placeholders with API endpoints
    let processedHtml = html_content;
    if (Object.keys(savedImages).length > 0) {
      const sortedImages = Object.entries(savedImages)
        .map(([path, data]) => ({ path, ...data }))
        .sort((a, b) => a.position - b.position);

      for (const img of sortedImages) {
        const filename = img.filename || img.path.split("/").pop();

        const patterns = [
          new RegExp(
            `src=["']IMAGE_PLACEHOLDER:${filename.replace(
              /[.*+?^${}()|[\]\\]/g,
              "\\$&"
            )}["']`,
            "gi"
          ),
          new RegExp(
            `src=["']blob:[^"']*${filename.replace(
              /[.*+?^${}()|[\]\\]/g,
              "\\$&"
            )}[^"']*["']`,
            "gi"
          ),
        ];

        const imageUrl = `src="/api/checksheet/templates/${templateId}/images/${img.id}"`;

        patterns.forEach((pattern) => {
          if (pattern.test(processedHtml)) {
            processedHtml = processedHtml.replace(pattern, imageUrl);
          }
        });
      }
    }

    // Update the template with processed HTML
    await client.query(
      `UPDATE checksheet_templates SET html_content = $1 WHERE id = $2`,
      [processedHtml, templateId]
    );

    // 5. Save field configurations to separate table
    if (field_configurations && Object.keys(field_configurations).length > 0) {
      for (const [fieldId, config] of Object.entries(field_configurations)) {
        await client.query(
          `
          INSERT INTO template_fields
          (template_id, field_name, field_type, label, decimal_places, options,
           bg_color, text_color, exact_match_text, exact_match_bg_color,
           min_length, min_length_mode, min_length_warning_bg,
           max_length, max_length_mode, max_length_warning_bg,
           multiline, auto_shrink_font,
           min_value, max_value, bg_color_in_range, bg_color_below_min,
           bg_color_above_max, border_color_in_range, border_color_below_min,
           border_color_above_max, formula, position, instance_id, sheet_index,
           date_format, show_time_select, DatetimeFormat, min_date, max_date,
           allow_camera, allow_upload,
           max_file_size, time_format, allow_seconds, min_time, max_time,
           required, disabled, mode, allow_text_input, allow_signature, allow_signature_over_text, 
           text_font_size)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47, $48, $49)
          `,
          [
            templateId,
            config.field_name || fieldId,
            config.type || "text",
            config.label || "",
            config.decimal_places || null,
            config.options ? JSON.stringify(config.options) : null,
            config.bgColor || "#ffffff",
            config.textColor || "#000000",
            config.exactMatchText || "",
            config.exactMatchBgColor || "#d4edda",
            config.minLength || null,
            config.minLengthMode || "warning",
            config.minLengthWarningBg || "#ffebee",
            config.maxLength || null,
            config.maxLengthMode || "warning",
            config.maxLengthWarningBg || "#fff3cd",
            config.multiline || false,
            config.autoShrinkFont !== false,
            config.min || null,
            config.max || null,
            config.bgColorInRange || "#ffffff",
            config.bgColorBelowMin || "#e3f2fd",
            config.bgColorAboveMax || "#ffebee",
            config.borderColorInRange || "#cccccc",
            config.borderColorBelowMin || "#2196f3",
            config.borderColorAboveMax || "#f44336",
            config.formula || "",
            config.position || "",
            config.instanceId || fieldId,
            config.sheetIndex || 0,
            config.dateFormat || "yyyy-MMMM-dd",
            config.showTimeSelect || false,
            config.DatetimeFormat || "HH:mm",
            config.minDate || null,
            config.maxDate || null,
            config.allowCamera || false,
            config.allowUpload || false,
            config.maxFileSize || null,
            config.timeFormat || "HH:mm:ss",
            config.allowSeconds || false,
            config.minTime || null,
            config.maxTime || null,
            config.required || false,
            config.disabled || false,
            config.mode || "signature_over_text",
            config.allowTextInput !== false,
            config.allowSignature !== false,
            config.allowSignatureOverText !== false,
            config.textFontSize || 16,
          ]
        );
      }
    }

    // 6. Create optimized dynamic table for submissions (Version 1)
    const tableName = `checksheet_${templateId}_1`;

    // Create table with proper data types
    await createOptimizedTable(client, tableName, field_configurations);

    // Update template with table name
    await client.query(
      `UPDATE checksheet_templates SET table_name = $1 WHERE id = $2`,
      [tableName, templateId]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      template_id: templateId,
      version: 1,
      table_name: tableName,
      message: "Form published successfully",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Publish form error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to publish form",
      details: err.message,
    });
  } finally {
    client.release();
  }
});

// ==============================
// GET IMAGE ENDPOINT
// ==============================
router.get("/templates/:id/images/:imageId", async (req, res) => {
  const { id, imageId } = req.params;

  try {
    const imageRes = await pool.query(
      `
      SELECT ti.mime_type, ti.image_data, ti.filename
      FROM template_images ti
      WHERE ti.id = $1 AND ti.template_id = $2
      `,
      [imageId, id]
    );

    if (imageRes.rows.length === 0) {
      return res.status(404).json({ error: "Image not found" });
    }

    const { mime_type, image_data, filename } = imageRes.rows[0];

    if (!image_data) {
      return res.status(404).json({ error: "Image data not found" });
    }

    const buffer = Buffer.from(image_data, "base64");

    res.setHeader("Content-Type", mime_type);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.setHeader("Cache-Control", "public, max-age=31536000");
    res.setHeader("ETag", `"${imageId}-${buffer.length}"`);

    res.send(buffer);
  } catch (err) {
    console.error("Get image error:", err);
    res.status(500).json({ error: "Failed to load image" });
  }
});

// ==============================
// GET ALL IMAGES FOR TEMPLATE
// ==============================
router.get("/templates/:id/images", async (req, res) => {
  const { id } = req.params;

  try {
    const imagesRes = await pool.query(
      `
      SELECT id, original_path, filename, mime_type, size, position_index, element_id, created_at
      FROM template_images 
      WHERE template_id = $1
      ORDER BY position_index ASC NULLS LAST, filename
      `,
      [id]
    );

    res.json({
      success: true,
      images: imagesRes.rows,
      count: imagesRes.rows.length,
    });
  } catch (err) {
    console.error("Get images error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to get images",
    });
  }
});

// ==============================
// GET TEMPLATE BY ID (COMPLETE)
// ==============================
router.get("/templates/:id", async (req, res) => {
  const { id } = req.params;

  try {
    // Get template basic info including version
    const templateRes = await pool.query(
      `
      SELECT 
        id, name, html_content, field_configurations, 
        field_positions, sheets, table_name, created_at,
        css_content, original_html_content, access_control,
        version, parent_template_id, is_active
      FROM checksheet_templates 
      WHERE id = $1
      `,
      [id]
    );

    if (templateRes.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Template not found",
      });
    }

    // Get all field configurations
    const fieldsRes = await pool.query(
      `
      SELECT 
        field_name, field_type, label, decimal_places, options,
        bg_color, text_color, exact_match_text, exact_match_bg_color,
        min_length, min_length_mode, min_length_warning_bg,
        max_length, max_length_mode, max_length_warning_bg,
        multiline, auto_shrink_font,
        min_value, max_value, bg_color_in_range, bg_color_below_min, 
        bg_color_above_max, border_color_in_range, border_color_below_min, 
        border_color_above_max, formula, position, instance_id, sheet_index,
        date_format, show_time_select, DatetimeFormat, min_date, max_date,
        allow_camera, allow_upload, allow_drawing, allow_cropping,
        max_file_size, aspect_ratio_width, aspect_ratio_height,
        time_format, allow_seconds, min_time, max_time, required, disabled, 
        mode, allow_text_input, allow_signature, allow_signature_over_text, text_font_size
      FROM template_fields 
      WHERE template_id = $1 
      ORDER BY id
      `,
      [id]
    );

    // Get images for this template
    const imagesRes = await pool.query(
      `
      SELECT id, filename, original_path, position_index, element_id
      FROM template_images 
      WHERE template_id = $1
      ORDER BY position_index ASC NULLS LAST, filename
      `,
      [id]
    );

    // Parse JSON fields
    const template = templateRes.rows[0];

    // Parse JSON data if it exists
    if (template.field_configurations) {
      try {
        template.field_configurations =
          typeof template.field_configurations === "string"
            ? JSON.parse(template.field_configurations)
            : template.field_configurations;
      } catch (e) {
        template.field_configurations = {};
      }
    } else {
      template.field_configurations = {};
    }

    if (template.field_positions) {
      try {
        template.field_positions =
          typeof template.field_positions === "string"
            ? JSON.parse(template.field_positions)
            : template.field_positions;
      } catch (e) {
        template.field_positions = {};
      }
    } else {
      template.field_positions = {};
    }

    if (template.sheets) {
      try {
        template.sheets =
          typeof template.sheets === "string"
            ? JSON.parse(template.sheets)
            : template.sheets;
      } catch (e) {
        template.sheets = [];
      }
    } else {
      template.sheets = [];
    }

    // Process field data
    const fields = fieldsRes.rows.map((field) => {
      const processedField = {
        field_name: field.field_name,
        field_type: field.field_type,
        label: field.label,
        decimal_places: field.decimal_places,
        options: field.options
          ? typeof field.options === "string"
            ? JSON.parse(field.options)
            : field.options
          : null,
        // All field settings
        bg_color: field.bg_color,
        text_color: field.text_color,
        exact_match_text: field.exact_match_text,
        exact_match_bg_color: field.exact_match_bg_color,
        min_length: field.min_length,
        min_length_mode: field.min_length_mode,
        min_length_warning_bg: field.min_length_warning_bg,
        max_length: field.max_length,
        max_length_mode: field.max_length_mode,
        max_length_warning_bg: field.max_length_warning_bg,
        multiline: field.multiline,
        auto_shrink_font: field.auto_shrink_font,
        min_value: field.min_value,
        max_value: field.max_value,
        bg_color_in_range: field.bg_color_in_range,
        bg_color_below_min: field.bg_color_below_min,
        bg_color_above_max: field.bg_color_above_max,
        border_color_in_range: field.border_color_in_range,
        border_color_below_min: field.border_color_below_min,
        border_color_above_max: field.border_color_above_max,
        formula: field.formula,
        position: field.position,
        instance_id: field.instance_id,
        sheet_index: field.sheet_index,
        date_format: field.date_format,
        show_time_select: field.show_time_select,
        DatetimeFormat: field.DatetimeFormat,
        min_date: field.min_date,
        max_date: field.max_date,
        allow_camera: field.allow_camera,
        allow_upload: field.allow_upload,
        allow_drawing: field.allow_drawing,
        allow_cropping: field.allow_cropping,
        max_file_size: field.max_file_size,
        aspect_ratio_width: field.aspect_ratio_width,
        aspect_ratio_height: field.aspect_ratio_height,
        time_format: field.time_format,
        allow_seconds: field.allow_seconds,
        min_time: field.min_time,
        max_time: field.max_time,
        required: field.required,
        disabled: field.disabled,
        // SIGNATURE FIELD PROPERTIES
        mode: field.mode || "signature_over_text",
        allowTextInput: field.allow_text_input !== false,
        allowSignature: field.allow_signature !== false,
        allowSignatureOverText: field.allow_signature_over_text !== false,
        textFontSize: field.text_font_size || 16,
      };

      return processedField;
    });

    // Process images
    const images = imagesRes.rows.map((image) => ({
      id: image.id,
      filename: image.filename,
      original_path: image.original_path,
      position_index: image.position_index,
      element_id: image.element_id,
    }));

    // Get version info
    const versionsRes = await pool.query(
      `SELECT COUNT(*) as version_count FROM checksheet_templates 
       WHERE parent_template_id = $1 OR id = $1`,
      [id]
    );

    res.json({
      success: true,
      template: {
        ...template,
        fields: fields,
        images: images,
        image_count: images.length,
        version_count: parseInt(versionsRes.rows[0].version_count),
      },
    });
  } catch (err) {
    console.error("Get template error:", err);
    res.status(500).json({
      success: false,
      message: "Server error",
      details: err.message,
    });
  }
});

router.get("/templates/:id/versions", async (req, res) => {
  const { id } = req.params;

  try {
    // Get all versions (including the specified template and its children)
    const versionsRes = await pool.query(
      `
      SELECT 
        id, name, version, table_name, created_at, updated_at, 
        is_active, parent_template_id
      FROM checksheet_templates 
      WHERE id = $1 OR parent_template_id = $1
      ORDER BY version ASC
      `,
      [id]
    );

    res.json({
      success: true,
      versions: versionsRes.rows,
      count: versionsRes.rows.length,
    });
  } catch (err) {
    console.error("Get versions error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to get template versions",
    });
  }
});

router.get("/templates/:id/submissions/all", async (req, res) => {
  const { id } = req.params;
  const { limit = 100, offset = 0 } = req.query;

  try {
    // Get all versions
    const versionsRes = await pool.query(
      `SELECT id, version, table_name FROM checksheet_templates 
       WHERE (id = $1 OR parent_template_id = $1) AND table_name IS NOT NULL
       ORDER BY version DESC`,
      [id]
    );

    if (versionsRes.rows.length === 0) {
      return res.json({
        success: true,
        submissions: [],
        total: 0,
        versions: [],
      });
    }

    // Build union query to get submissions from all versions
    const unionParts = versionsRes.rows
      .map((row) => {
        return `SELECT 
                ${row.id} as template_id,
                ${row.version} as version,
                t.* 
              FROM "${row.table_name}" t`;
      })
      .join(" UNION ALL ");

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total
      FROM (${unionParts}) as all_submissions
    `;

    const countRes = await pool.query(countQuery);
    const total = parseInt(countRes.rows[0].total);

    // Get paginated results
    const dataQuery = `
      SELECT *
      FROM (${unionParts}) as all_submissions
      ORDER BY submitted_at DESC
      LIMIT $1 OFFSET $2
    `;

    const dataRes = await pool.query(dataQuery, [limit, offset]);

    res.json({
      success: true,
      submissions: dataRes.rows,
      total: total,
      versions: versionsRes.rows.map((v) => ({ id: v.id, version: v.version })),
      current_limit: parseInt(limit),
      current_offset: parseInt(offset),
    });
  } catch (err) {
    console.error("Get all submissions error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to get submissions",
      details: err.message,
    });
  }
});

// ==============================
// SUBMIT DATA TO DYNAMIC TABLE
// ==============================
// SUBMIT DATA AND AUTO-CREATE REPORT TABLE (View created only once)
// ==============================
// ==============================
// SUBMIT DATA TO DYNAMIC TABLE - CASE-INSENSITIVE FIX
// ==============================
router.post("/submissions", async (req, res) => {
  const { template_id, user_id, data } = req.body;

  console.log("=== SUBMISSION DEBUG ===");
  console.log("Template ID:", template_id);
  console.log("User ID:", user_id);
  console.log("Submitted data keys:", Object.keys(data));

  if (!template_id || !user_id || !data || typeof data !== "object") {
    return res.status(400).json({
      success: false,
      message: "Invalid submission data",
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Get template info with version
    const templateRes = await client.query(
      `SELECT id, name, table_name, version FROM checksheet_templates WHERE id = $1 AND is_active = true`,
      [template_id]
    );

    if (templateRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, message: "Template not found or not active" });
    }

    const template = templateRes.rows[0];
    const submissionsTable = template.table_name;
    const version = template.version || 1;

    console.log(
      "Template:",
      template.name,
      "Version:",
      version,
      "Table:",
      submissionsTable
    );

    // 2. Get actual columns from the submissions table (case-insensitive)
    const tableColumnsRes = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = '${submissionsTable}'
      ORDER BY ordinal_position
    `);

    const existingColumns = tableColumnsRes.rows.map((row) => row.column_name);
    console.log("Existing columns in table:", existingColumns);

    // 3. Get field definitions for THIS specific template
    const fieldsRes = await client.query(
      `SELECT 
        field_name, 
        instance_id,
        label,
        field_type
       FROM template_fields 
       WHERE template_id = $1
       ORDER BY id`,
      [template_id]
    );

    console.log(
      "Fields for template",
      template_id,
      ":",
      fieldsRes.rows.length,
      "fields"
    );

    // 4. Create case-insensitive mapping
    const existingColumnsLower = existingColumns.map((col) =>
      col.toLowerCase()
    );

    const columnMap = {};
    existingColumns.forEach((col) => {
      columnMap[col.toLowerCase()] = col;
    });

    const fieldMapping = {};
    fieldsRes.rows.forEach((field) => {
      const fieldName = field.field_name;
      const instanceId = field.instance_id;

      const lowerFieldName = fieldName.toLowerCase();
      const lowerInstanceId = instanceId.toLowerCase();

      fieldMapping[fieldName] = { original: fieldName, lower: lowerFieldName };
      fieldMapping[instanceId] = {
        original: instanceId,
        lower: lowerInstanceId,
      };

      fieldMapping[lowerFieldName] = {
        original: fieldName,
        lower: lowerFieldName,
      };
      fieldMapping[lowerInstanceId] = {
        original: instanceId,
        lower: lowerInstanceId,
      };
    });

    const submittedKeys = Object.keys(data);

    // 5. Prepare columns and values for insertion
    const columnsToInsert = ["user_id", "template_version"];
    let valuesToInsert = [user_id, version];

    const mappings = [];

    // Validate each submitted field against template fields
    for (const submittedKey of submittedKeys) {
      let matchedColumn = null;

      const submittedLower = submittedKey.toLowerCase();

      if (columnMap[submittedLower]) {
        matchedColumn = columnMap[submittedLower];
        console.log(`✓ Direct match: "${submittedKey}" -> "${matchedColumn}"`);
      } else if (fieldMapping[submittedKey] || fieldMapping[submittedLower]) {
        const fieldInfo =
          fieldMapping[submittedKey] || fieldMapping[submittedLower];
        const lowerFieldName = fieldInfo.lower;

        if (columnMap[lowerFieldName]) {
          matchedColumn = columnMap[lowerFieldName];
          console.log(
            `✓ Field mapping match: "${submittedKey}" -> "${matchedColumn}" via ${lowerFieldName}`
          );
        }
      }

      if (matchedColumn) {
        columnsToInsert.push(matchedColumn);

        // Convert value based on field type
        const fieldType = fieldsRes.rows.find(
          (f) =>
            f.field_name.toLowerCase() === submittedLower ||
            f.instance_id.toLowerCase() === submittedLower
        )?.field_type;

        let value = data[submittedKey];

        // Handle type conversions
        if (fieldType === "number" || fieldType === "calculation") {
          // Treat empty string, null, undefined, "NaN", etc. as null
          if (
            value == null ||
            value === "" ||
            value === "NaN" ||
            Number.isNaN(value)
          ) {
            value = null;
          } else {
            const num = parseFloat(value);
            value = Number.isNaN(num) ? null : num;
          }
        } else if (["date", "datetime", "time"].includes(fieldType)) {
          value = (value || "").trim() === "" ? null : value;
        }

        valuesToInsert.push(value);
        mappings.push({
          submitted: submittedKey,
          column: matchedColumn,
          type: fieldType,
        });
      } else {
        console.warn(`⚠️ No column found for field: "${submittedKey}"`);
      }
    }

    console.log("Final columns to insert:", columnsToInsert);

    // 6. Validate we have data to insert
    if (columnsToInsert.length <= 2) {
      // Only user_id and template_version
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "No valid fields to insert. Check field names.",
        debug: {
          template_id: template_id,
          template_name: template.name,
          version: version,
          table: submissionsTable,
          existing_columns: existingColumns,
          submitted_keys: submittedKeys,
          mappings: mappings,
        },
      });
    }

    // 7. Build and execute the insert query
    const placeholders = columnsToInsert.map((_, i) => `$${i + 1}`).join(", ");
    const safeCols = columnsToInsert
      .map((c) => `"${c.replace(/"/g, '""')}"`)
      .join(", ");

    const insertQuery = `
      INSERT INTO "${submissionsTable}" (${safeCols})
      VALUES (${placeholders})
      RETURNING id, submitted_at
    `;

    console.log("Insert SQL:", insertQuery);

    const submissionResult = await client.query(insertQuery, valuesToInsert);
    const submissionId = submissionResult.rows[0].id;
    const submittedAt = submissionResult.rows[0].submitted_at;

    console.log("✅ Insert successful, ID:", submissionId, "Version:", version);

    await client.query("COMMIT");

    res.json({
      success: true,
      submission_id: submissionId,
      submitted_at: submittedAt,
      template_name: template.name,
      template_version: version,
      message: "Form submitted successfully",
      debug: {
        fields_mapped: columnsToInsert.length - 2, // minus user_id and template_version
        total_fields: submittedKeys.length,
        version: version,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Submission error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to save submission",
      details: err.message,
      error_code: err.code,
      hint: "Field name case sensitivity issue. Check if field names match table columns exactly.",
    });
  } finally {
    client.release();
  }
});

// ==============================
// DELETE TEMPLATE
// ==============================
router.delete("/templates/:id", async (req, res) => {
  const { id } = req.params;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Get template and all its versions
    const templateRes = await client.query(
      "SELECT id, table_name, parent_template_id FROM checksheet_templates WHERE id = $1",
      [id]
    );

    if (templateRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Template not found",
      });
    }

    const template = templateRes.rows[0];

    // 2. Get all versions to delete
    const versionsRes = await client.query(
      `SELECT id, table_name FROM checksheet_templates 
       WHERE id = $1 OR parent_template_id = $1`,
      [id]
    );

    // 3. Delete dynamic tables for all versions
    for (const version of versionsRes.rows) {
      if (version.table_name) {
        try {
          await client.query(
            `DROP TABLE IF EXISTS "${version.table_name}" CASCADE`
          );
          console.log(`Dropped table: ${version.table_name}`);
        } catch (dropError) {
          console.warn(
            `Could not drop table ${version.table_name}:`,
            dropError.message
          );
        }
      }
    }

    // 4. Delete images for all versions
    await client.query(
      `DELETE FROM template_images 
       WHERE template_id IN (
         SELECT id FROM checksheet_templates 
         WHERE id = $1 OR parent_template_id = $1
       )`,
      [id]
    );

    // 5. Delete field configurations for all versions
    await client.query(
      `DELETE FROM template_fields 
       WHERE template_id IN (
         SELECT id FROM checksheet_templates 
         WHERE id = $1 OR parent_template_id = $1
       )`,
      [id]
    );

    // 6. Delete all versions of the template
    await client.query(
      `DELETE FROM checksheet_templates 
       WHERE id = $1 OR parent_template_id = $1`,
      [id]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: `Template and ${versionsRes.rows.length} version(s) deleted successfully`,
      versions_deleted: versionsRes.rows.length,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Delete template error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to delete template",
      details: err.message,
    });
  } finally {
    client.release();
  }
});

// ==============================
// FOLDER MANAGEMENT ENDPOINTS
// ==============================

// Create folder
router.post("/folders", async (req, res) => {
  const { name, parent_id, user_id } = req.body;

  if (!name || name.trim() === "") {
    return res.status(400).json({
      success: false,
      message: "Folder name is required",
    });
  }

  try {
    // Check if folder name already exists in same parent
    const existingRes = await pool.query(
      `SELECT id FROM form_folders 
       WHERE name = $1 AND parent_id = $2 AND user_id = $3`,
      [name.trim(), parent_id || null, user_id || null]
    );

    if (existingRes.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Folder with this name already exists in this location",
      });
    }

    const result = await pool.query(
      `INSERT INTO form_folders (name, parent_id, user_id) 
       VALUES ($1, $2, $3) 
       RETURNING id, name, parent_id, created_at`,
      [name.trim(), parent_id || null, user_id || null]
    );

    res.json({
      success: true,
      folder: result.rows[0],
      message: "Folder created successfully",
    });
  } catch (err) {
    console.error("Create folder error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to create folder",
    });
  }
});

// Get all folders (tree structure)
router.get("/folders", async (req, res) => {
  try {
    const foldersRes = await pool.query(
      `SELECT id, name, parent_id, created_at, updated_at 
       FROM form_folders 
       ORDER BY name`
    );

    // Build tree structure
    const buildTree = (parentId = null) => {
      return foldersRes.rows
        .filter((folder) => folder.parent_id === parentId)
        .map((folder) => ({
          ...folder,
          children: buildTree(folder.id),
          itemCount: 0, // Will be populated later
        }));
    };

    const tree = buildTree();

    // **CRITICAL FIX: Get ALL form counts for each folder**
    const countsRes = await pool.query(
      `SELECT 
        COALESCE(folder_id, -1) as folder_id, 
        COUNT(*) as count 
       FROM checksheet_templates 
       GROUP BY folder_id`
    );

    const countsMap = {};
    countsRes.rows.forEach((row) => {
      // Use null for root forms (folder_id is null)
      const folderId = row.folder_id === -1 ? null : row.folder_id;
      countsMap[folderId] = parseInt(row.count);
    });

    console.log("=== DEBUG FOLDER COUNTS ===");
    console.log("Counts map:", countsMap);

    // Helper function to update counts recursively
    const updateCounts = (folders) => {
      return folders.map((folder) => {
        // Start with direct forms in this folder
        let total = countsMap[folder.id] || 0;

        console.log(
          `Folder ${folder.id} (${folder.name}): direct count = ${total}`
        );

        if (folder.children && folder.children.length > 0) {
          const updatedChildren = updateCounts(folder.children);
          const childrenCount = updatedChildren.reduce(
            (sum, child) => sum + child.itemCount,
            0
          );
          total += childrenCount;

          return {
            ...folder,
            children: updatedChildren,
            itemCount: total,
          };
        }

        return {
          ...folder,
          itemCount: total,
        };
      });
    };

    const treeWithCounts = updateCounts(tree);

    console.log("=== FINAL FOLDER TREE ===");
    console.log(JSON.stringify(treeWithCounts, null, 2));

    res.json({
      success: true,
      folders: treeWithCounts,
    });
  } catch (err) {
    console.error("Get folders error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to get folders",
      error: err.message,
    });
  }
});

// Update folder
router.put("/folders/:id", async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;

  if (!name || name.trim() === "") {
    return res.status(400).json({
      success: false,
      message: "Folder name is required",
    });
  }

  try {
    // Check if folder exists
    const folderRes = await pool.query(
      "SELECT id FROM form_folders WHERE id = $1",
      [id]
    );

    if (folderRes.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Folder not found",
      });
    }

    // Check for duplicate name in same parent
    const parentRes = await pool.query(
      "SELECT parent_id FROM form_folders WHERE id = $1",
      [id]
    );

    const duplicateRes = await pool.query(
      `SELECT id FROM form_folders 
       WHERE name = $1 AND parent_id = $2 AND id != $3`,
      [name.trim(), parentRes.rows[0].parent_id, id]
    );

    if (duplicateRes.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Folder with this name already exists in this location",
      });
    }

    const result = await pool.query(
      `UPDATE form_folders 
       SET name = $1, updated_at = NOW() 
       WHERE id = $2 
       RETURNING id, name, parent_id, updated_at`,
      [name.trim(), id]
    );

    res.json({
      success: true,
      folder: result.rows[0],
      message: "Folder updated successfully",
    });
  } catch (err) {
    console.error("Update folder error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to update folder",
    });
  }
});

// Delete folder
router.delete("/folders/:id", async (req, res) => {
  const { id } = req.params;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Check if folder exists
    const folderRes = await client.query(
      "SELECT id FROM form_folders WHERE id = $1",
      [id]
    );

    if (folderRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Folder not found",
      });
    }

    // Check if folder has forms
    const formsRes = await client.query(
      "SELECT COUNT(*) as count FROM checksheet_templates WHERE folder_id = $1",
      [id]
    );

    if (parseInt(formsRes.rows[0].count) > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message:
          "Cannot delete folder that contains forms. Move or delete the forms first.",
      });
    }

    // Delete folder (cascade will handle subfolders)
    await client.query("DELETE FROM form_folders WHERE id = $1", [id]);

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Folder deleted successfully",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Delete folder error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to delete folder",
    });
  } finally {
    client.release();
  }
});

// Move forms to folder (bulk operation)
router.post("/forms/move", async (req, res) => {
  const { formIds, folderId } = req.body;

  if (!Array.isArray(formIds) || formIds.length === 0) {
    return res.status(400).json({
      success: false,
      message: "No forms selected",
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Validate folder if provided (null means move to root)
    if (folderId !== null && folderId !== undefined) {
      const folderRes = await client.query(
        "SELECT id FROM form_folders WHERE id = $1",
        [folderId]
      );

      if (folderRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          success: false,
          message: "Folder not found",
        });
      }
    }

    // Update forms
    const result = await client.query(
      `UPDATE checksheet_templates 
       SET folder_id = $1 
       WHERE id = ANY($2) 
       RETURNING id, name, folder_id`,
      [folderId || null, formIds]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      movedCount: result.rowCount,
      message: `${result.rowCount} form(s) moved successfully`,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Move forms error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to move forms",
    });
  } finally {
    client.release();
  }
});

// Update GET templates endpoint to include folder info
// In checksheet.js backend, update the GET /templates endpoint:
router.get("/templates", async (req, res) => {
  try {
    const templatesRes = await pool.query(
      `SELECT 
        ct.id, 
        ct.name, 
        ct.table_name, 
        ct.created_at,
        ct.folder_id,
        ff.name as folder_name,
        ct.access_control 
       FROM checksheet_templates ct
       LEFT JOIN form_folders ff ON ct.folder_id = ff.id
       ORDER BY ct.created_at DESC`
    );

    console.log("=== DEBUG: TEMPLATES API RESPONSE ===");
    console.log("Total templates:", templatesRes.rows.length);

    res.json({
      success: true,
      templates: templatesRes.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Save/update form access control
router.post("/templates/:id/access-control", async (req, res) => {
  const { id } = req.params;
  const { groups, field_permissions, default_access } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Update template with access control
    await client.query(
      `UPDATE checksheet_templates 
       SET access_control = $1 
       WHERE id = $2`,
      [
        JSON.stringify({
          groups,
          field_permissions,
          default_access,
          updated_at: new Date().toISOString(),
        }),
        id,
      ]
    );

    // 2. Clear existing group permissions
    await client.query(`DELETE FROM form_access_control WHERE form_id = $1`, [
      id,
    ]);

    // 3. Insert new group permissions
    if (groups && groups.length > 0) {
      for (const groupId of groups) {
        await client.query(
          `INSERT INTO form_access_control 
           (form_id, group_id, can_view, can_edit, can_delete)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, groupId, true, false, false]
        );
      }
    }

    // 4. Clear existing field permissions
    await client.query(`DELETE FROM field_permissions WHERE form_id = $1`, [
      id,
    ]);

    // 5. Insert field-level permissions
    if (field_permissions && Object.keys(field_permissions).length > 0) {
      for (const [permissionKey, permission] of Object.entries(
        field_permissions
      )) {
        // Split using the new separator |||
        const parts = permissionKey.split("|||");
        if (parts.length !== 2) {
          console.warn(
            "Invalid permission key format (skipping):",
            permissionKey
          );
          continue;
        }
        const fieldInstanceId = parts[0];
        const groupIdStr = parts[1];
        const groupId = parseInt(groupIdStr, 10);

        if (isNaN(groupId)) {
          console.warn(
            "Invalid group ID in permission key (skipping):",
            permissionKey
          );
          continue;
        }

        await client.query(
          `INSERT INTO field_permissions 
       (form_id, field_instance_id, group_id, can_view, can_edit, can_delete)
       VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            id,
            fieldInstanceId,
            groupId,
            permission.canView ?? true,
            permission.canEdit ?? true,
            permission.canDelete || false,
          ]
        );
      }
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Access control settings saved successfully",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Save access control error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to save access control settings",
    });
  } finally {
    client.release();
  }
});

// Get form access control
// In checksheet.js, update the GET /templates/:id/access-control endpoint:

// Get form access control
router.get("/templates/:id/access-control", async (req, res) => {
  const { id } = req.params;

  try {
    // Get template access control
    const templateRes = await pool.query(
      `SELECT access_control FROM checksheet_templates WHERE id = $1`,
      [id]
    );

    if (templateRes.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Template not found",
      });
    }

    let accessControl = {};
    if (templateRes.rows[0].access_control) {
      try {
        accessControl =
          typeof templateRes.rows[0].access_control === "string"
            ? JSON.parse(templateRes.rows[0].access_control)
            : templateRes.rows[0].access_control;
      } catch (e) {
        console.error("Error parsing access control JSON:", e);
      }
    }

    // Get form group permissions
    const groupPermissionsRes = await pool.query(
      `SELECT fac.group_id, ug.group_name, ug.color,
              fac.can_view, fac.can_edit, fac.can_delete
       FROM form_access_control fac
       LEFT JOIN user_groups ug ON fac.group_id = ug.group_id
       WHERE fac.form_id = $1`,
      [id]
    );

    // Get field permissions - FIXED QUERY
    const fieldPermissionsRes = await pool.query(
      `SELECT field_instance_id, group_id, 
              can_view, can_edit, can_delete
       FROM field_permissions 
       WHERE form_id = $1`,
      [id]
    );

    // Convert field permissions to object format with ||| separator
    const fieldPermissions = {};
    fieldPermissionsRes.rows.forEach((row) => {
      // Use ||| separator to match how it's stored
      const key = `${row.field_instance_id}|||${row.group_id}`;
      fieldPermissions[key] = {
        canView: row.can_view,
        canEdit: row.can_edit,
        canDelete: row.can_delete,
      };
    });

    // Get group details even if not in form_access_control table
    const allGroupsRes = await pool.query(
      `SELECT group_id, group_name, color, description 
       FROM user_groups 
       ORDER BY group_name`
    );

    // Determine which groups are selected
    const selectedGroupIds = groupPermissionsRes.rows.map((g) => g.group_id);

    res.json({
      success: true,
      access_control: {
        ...accessControl,
        groups: selectedGroupIds, // Array of group IDs
        field_permissions: fieldPermissions,
        group_details: allGroupsRes.rows.map((group) => ({
          ...group,
          selected: selectedGroupIds.includes(group.group_id),
        })),
      },
    });
  } catch (err) {
    console.error("Get access control error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to get access control settings",
      details: err.message,
    });
  }
});

// Add this route to your auth or user routes
// FIXED: Correct user-info endpoint for your database schema
router.get("/user-info", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.log("No Bearer token provided");
      return res.status(401).json({ error: "No token provided" });
    }

    const token = authHeader.split(" ")[1];
    let userId;

    // Decode JWT safely
    try {
      const payload = JSON.parse(
        Buffer.from(token.split(".")[1], "base64").toString()
      );
      userId = payload.user_id || payload.sub || payload.id;

      if (!userId) {
        return res.status(401).json({ error: "Invalid token: no user_id" });
      }
    } catch (decodeErr) {
      console.error("Token decode failed:", decodeErr.message);
      return res.status(401).json({ error: "Invalid token" });
    }

    console.log("Fetching user info for user_id:", userId);

    // CORRECT TABLE: usermaster
    // CORRECT COLUMN: user_id
    // ADD is_admin column safely
    const userRes = await pool.query(
      `SELECT 
         user_id, 
         name AS username, 
         email, 
         COALESCE(is_admin, false) AS is_admin 
       FROM usermaster 
       WHERE user_id = $1`,
      [userId]
    );

    if (userRes.rows.length === 0) {
      console.log("User not found with user_id:", userId);
      return res.status(404).json({ error: "User not found" });
    }

    const user = userRes.rows[0];

    console.log("User found:", user.username, "| is_admin:", user.is_admin);

    res.json({
      user_id: parseInt(user.user_id),
      username: user.username || "Unknown",
      email: user.email || "",
      is_admin: Boolean(user.is_admin),
    });
  } catch (err) {
    console.error("Get user info ERROR:", err.message);
    console.error(err.stack);
    res.status(500).json({
      error: "Server error",
      details: err.message,
    });
  }
});

// Add this to your backend (checksheet.js)
router.get("/templates/:id/full", async (req, res) => {
  const { id } = req.params;

  try {
    // Get template basic info including version
    const templateRes = await pool.query(
      `
      SELECT 
        id, name, html_content, field_configurations, 
        field_positions, sheets, table_name, created_at,
        css_content, original_html_content, access_control,
        version, parent_template_id, is_active
      FROM checksheet_templates 
      WHERE id = $1
      `,
      [id]
    );

    if (templateRes.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Template not found",
      });
    }

    // Get all field configurations
    const fieldsRes = await pool.query(
      `
      SELECT 
        field_name, field_type, label, decimal_places, options,
        bg_color, text_color, exact_match_text, exact_match_bg_color,
        min_length, min_length_mode, min_length_warning_bg,
        max_length, max_length_mode, max_length_warning_bg,
        multiline, auto_shrink_font,
        min_value, max_value, bg_color_in_range, bg_color_below_min, 
        bg_color_above_max, border_color_in_range, border_color_below_min, 
        border_color_above_max, formula, position, instance_id, sheet_index,
        date_format, show_time_select, DatetimeFormat, min_date, max_date,
        allow_camera, allow_upload, max_file_size,
        time_format, allow_seconds, min_time, max_time, 
        required, disabled, mode, allow_text_input, allow_signature, 
        allow_signature_over_text, text_font_size
      FROM template_fields 
      WHERE template_id = $1 
      ORDER BY id
      `,
      [id]
    );

    // Get images for this template
    const imagesRes = await pool.query(
      `
      SELECT id, filename, original_path, position_index, element_id
      FROM template_images 
      WHERE template_id = $1
      ORDER BY position_index ASC NULLS LAST, filename
      `,
      [id]
    );

    // Parse JSON fields
    const template = templateRes.rows[0];

    // Parse JSON data if it exists
    if (template.field_configurations) {
      try {
        template.field_configurations =
          typeof template.field_configurations === "string"
            ? JSON.parse(template.field_configurations)
            : template.field_configurations;
      } catch (e) {
        template.field_configurations = {};
      }
    } else {
      template.field_configurations = {};
    }

    if (template.field_positions) {
      try {
        template.field_positions =
          typeof template.field_positions === "string"
            ? JSON.parse(template.field_positions)
            : template.field_positions;
      } catch (e) {
        template.field_positions = {};
      }
    } else {
      template.field_positions = {};
    }

    if (template.sheets) {
      try {
        template.sheets =
          typeof template.sheets === "string"
            ? JSON.parse(template.sheets)
            : template.sheets;
      } catch (e) {
        template.sheets = [];
      }
    } else {
      template.sheets = [];
    }

    // Process field data
    const fields = fieldsRes.rows.map((field) => {
      const processedField = {
        field_name: field.field_name,
        type: field.field_type,
        label: field.label,
        decimal_places: field.decimal_places,
        options: field.options
          ? typeof field.options === "string"
            ? JSON.parse(field.options)
            : field.options
          : null,
        // All field settings
        bgColor: field.bg_color,
        textColor: field.text_color,
        exactMatchText: field.exact_match_text,
        exactMatchBgColor: field.exact_match_bg_color,
        minLength: field.min_length,
        minLengthMode: field.min_length_mode,
        minLengthWarningBg: field.min_length_warning_bg,
        maxLength: field.max_length,
        maxLengthMode: field.max_length_mode,
        maxLengthWarningBg: field.max_length_warning_bg,
        multiline: field.multiline,
        autoShrinkFont: field.auto_shrink_font,
        min: field.min_value,
        max: field.max_value,
        bgColorInRange: field.bg_color_in_range,
        bgColorBelowMin: field.bg_color_below_min,
        bgColorAboveMax: field.bg_color_above_max,
        borderColorInRange: field.border_color_in_range,
        borderColorBelowMin: field.border_color_below_min,
        borderColorAboveMax: field.border_color_above_max,
        formula: field.formula,
        position: field.position,
        instanceId: field.instance_id,
        sheetIndex: field.sheet_index,
        dateFormat: field.date_format,
        showTimeSelect: field.show_time_select,
        DatetimeFormat: field.DatetimeFormat,
        minDate: field.min_date,
        maxDate: field.max_date,
        allowCamera: field.allow_camera,
        allowUpload: field.allow_upload,
        maxFileSize: field.max_file_size,
        timeFormat: field.time_format,
        allowSeconds: field.allow_seconds,
        minTime: field.min_time,
        maxTime: field.max_time,
        required: field.required,
        disabled: field.disabled,
        // SIGNATURE FIELD PROPERTIES
        mode: field.mode || "signature_over_text",
        allowTextInput: field.allow_text_input !== false,
        allowSignature: field.allow_signature !== false,
        allowSignatureOverText: field.allow_signature_over_text !== false,
        textFontSize: field.text_font_size || 16,
      };

      return processedField;
    });

    // Convert fields array to object keyed by instanceId
    const fieldConfigurations = {};
    fields.forEach((field) => {
      fieldConfigurations[field.instanceId] = field;
    });

    // Process images
    const images = {};
    imagesRes.rows.forEach((image) => {
      images[image.filename] = {
        id: image.id,
        filename: image.filename,
        original_path: image.original_path,
        position_index: image.position_index,
        element_id: image.element_id,
      };
    });

    res.json({
      success: true,
      template: {
        ...template,
        field_configurations: fieldConfigurations,
        images: images,
        image_count: imagesRes.rows.length,
      },
    });
  } catch (err) {
    console.error("Get template error:", err);
    res.status(500).json({
      success: false,
      message: "Server error",
      details: err.message,
    });
  }
});

// Add update endpoint to your backend
router.put("/templates/:id", async (req, res) => {
  const { id } = req.params;
  const {
    name,
    html_content,
    original_html_content,
    field_configurations,
    field_positions,
    sheets,
    form_values,
    css_content = "",
    images = {},
    access_control,
    is_update = false,
    original_template_id = null,
  } = req.body;

  if (!name) {
    return res.status(400).json({
      success: false,
      message: "Form name is required",
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    console.log("=== UPDATING FORM ===");
    console.log("Form ID:", id);
    console.log("Is update:", is_update);
    console.log("Original template ID:", original_template_id);

    // Check if template exists
    const existingRes = await client.query(
      "SELECT id, name, version, table_name FROM checksheet_templates WHERE id = $1",
      [id]
    );

    if (existingRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Template not found",
      });
    }

    const existingTemplate = existingRes.rows[0];
    const currentVersion = existingTemplate.version || 1;

    // Get current field configurations to detect changes
    const currentFieldsRes = await client.query(
      `SELECT field_name, field_type, instance_id 
       FROM template_fields 
       WHERE template_id = $1`,
      [id]
    );

    // Detect schema changes
    const changes = detectSchemaChanges(
      currentFieldsRes.rows,
      field_configurations || {}
    );
    const hasBreakingChanges = changes.some((c) => c.breakingChange);

    console.log("Schema changes detected:", changes);
    console.log("Has breaking changes:", hasBreakingChanges);

    // If breaking changes, create new version
    if (hasBreakingChanges) {
      console.log("Creating new version due to breaking changes");

      // Get parent template ID for versioning
      const parentTemplateId = original_template_id || id;

      // Get next version number
      const versionRes = await client.query(
        `SELECT COALESCE(MAX(version), 0) + 1 as new_version
         FROM checksheet_templates 
         WHERE parent_template_id = $1 OR id = $1`,
        [parentTemplateId]
      );

      const newVersion = versionRes.rows[0].new_version;
      const newTableName = `checksheet_${parentTemplateId}_${newVersion}`;

      // Archive current template
      await client.query(
        `UPDATE checksheet_templates 
         SET is_active = false,
             archived_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [id]
      );

      // Create new template as version
      const newTemplateRes = await client.query(
        `INSERT INTO checksheet_templates 
         (name, html_content, field_configurations, field_positions,
          sheets, css_content, original_html_content, access_control,
          table_name, version, parent_template_id, is_active)
         SELECT 
           $1,
           $2, $3, $4,
           $5, $6, $7, $8,
           $9, $10, $11, true
         FROM checksheet_templates 
         WHERE id = $12
         RETURNING id`,
        [
          name,
          html_content || "",
          field_configurations ? JSON.stringify(field_configurations) : null,
          field_positions ? JSON.stringify(field_positions) : null,
          sheets ? JSON.stringify(sheets) : null,
          css_content || "",
          original_html_content || "",
          access_control ? JSON.stringify(access_control) : null,
          newTableName,
          newVersion,
          parentTemplateId,
          id,
        ]
      );

      const newTemplateId = newTemplateRes.rows[0].id;

      // Create optimized table for new version
      if (field_configurations) {
        await createOptimizedTable(client, newTableName, field_configurations);
      }

      // Migrate non-breaking data from old version
      if (existingTemplate.table_name) {
        const migratedCount = await migrateNonBreakingData(
          client,
          existingTemplate.table_name,
          newTableName,
          changes,
          newVersion
        );
        console.log(`Migrated ${migratedCount} records to new version`);
      }

      // Copy images to new template
      await client.query(
        `INSERT INTO template_images 
         (template_id, original_path, filename, mime_type, image_data, size, 
          position_index, original_src, element_id)
         SELECT $1, original_path, filename, mime_type, image_data, size, 
                position_index, original_src, element_id
         FROM template_images 
         WHERE template_id = $2`,
        [newTemplateId, id]
      );

      // Copy field configurations to new template
      await client.query(
        `INSERT INTO template_fields 
         (template_id, field_name, field_type, label, decimal_places, options,
          bg_color, text_color, exact_match_text, exact_match_bg_color,
          min_length, min_length_mode, min_length_warning_bg,
          max_length, max_length_mode, max_length_warning_bg,
          multiline, auto_shrink_font,
          min_value, max_value, bg_color_in_range, bg_color_below_min,
          bg_color_above_max, border_color_in_range, border_color_below_min,
          border_color_above_max, formula, position, instance_id, sheet_index,
          date_format, show_time_select, DatetimeFormat, min_date, max_date,
          allow_camera, allow_upload, max_file_size, time_format, allow_seconds, 
          min_time, max_time, required, disabled, mode, allow_text_input, 
          allow_signature, allow_signature_over_text, text_font_size)
         SELECT $1, field_name, field_type, label, decimal_places, options,
                bg_color, text_color, exact_match_text, exact_match_bg_color,
                min_length, min_length_mode, min_length_warning_bg,
                max_length, max_length_mode, max_length_warning_bg,
                multiline, auto_shrink_font,
                min_value, max_value, bg_color_in_range, bg_color_below_min,
                bg_color_above_max, border_color_in_range, border_color_below_min,
                border_color_above_max, formula, position, instance_id, sheet_index,
                date_format, show_time_select, DatetimeFormat, min_date, max_date,
                allow_camera, allow_upload, max_file_size, time_format, allow_seconds, 
                min_time, max_time, required, disabled, mode, allow_text_input, 
                allow_signature, allow_signature_over_text, text_font_size
         FROM template_fields 
         WHERE template_id = $2`,
        [newTemplateId, id]
      );

      // Update new field configurations if provided
      if (
        field_configurations &&
        Object.keys(field_configurations).length > 0
      ) {
        await client.query(
          "DELETE FROM template_fields WHERE template_id = $1",
          [newTemplateId]
        );

        for (const [fieldId, config] of Object.entries(field_configurations)) {
          await client.query(
            `
            INSERT INTO template_fields
            (template_id, field_name, field_type, label, decimal_places, options,
             bg_color, text_color, exact_match_text, exact_match_bg_color,
             min_length, min_length_mode, min_length_warning_bg,
             max_length, max_length_mode, max_length_warning_bg,
             multiline, auto_shrink_font,
             min_value, max_value, bg_color_in_range, bg_color_below_min,
             bg_color_above_max, border_color_in_range, border_color_below_min,
             border_color_above_max, formula, position, instance_id, sheet_index,
             date_format, show_time_select, DatetimeFormat, min_date, max_date,
             allow_camera, allow_upload,
             max_file_size, time_format, allow_seconds, min_time, max_time,
             required, disabled, mode, allow_text_input, allow_signature, allow_signature_over_text, 
             text_font_size)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47, $48, $49)
            `,
            [
              newTemplateId,
              config.field_name || fieldId,
              config.type || "text",
              config.label || "",
              config.decimal_places || null,
              config.options ? JSON.stringify(config.options) : null,
              config.bgColor || "#ffffff",
              config.textColor || "#000000",
              config.exactMatchText || "",
              config.exactMatchBgColor || "#d4edda",
              config.minLength || null,
              config.minLengthMode || "warning",
              config.minLengthWarningBg || "#ffebee",
              config.maxLength || null,
              config.maxLengthMode || "warning",
              config.maxLengthWarningBg || "#fff3cd",
              config.multiline || false,
              config.autoShrinkFont !== false,
              config.min || null,
              config.max || null,
              config.bgColorInRange || "#ffffff",
              config.bgColorBelowMin || "#e3f2fd",
              config.bgColorAboveMax || "#ffebee",
              config.borderColorInRange || "#cccccc",
              config.borderColorBelowMin || "#2196f3",
              config.borderColorAboveMax || "#f44336",
              config.formula || "",
              config.position || "",
              config.instanceId || fieldId,
              config.sheetIndex || 0,
              config.dateFormat || "yyyy-MMMM-dd",
              config.showTimeSelect || false,
              config.DatetimeFormat || "HH:mm",
              config.minDate || null,
              config.maxDate || null,
              config.allowCamera || false,
              config.allowUpload || false,
              config.maxFileSize || null,
              config.timeFormat || "HH:mm:ss",
              config.allowSeconds || false,
              config.minTime || null,
              config.maxTime || null,
              config.required || false,
              config.disabled || false,
              config.mode || "signature_over_text",
              config.allowTextInput !== false,
              config.allowSignature !== false,
              config.allowSignatureOverText !== false,
              config.textFontSize || 16,
            ]
          );
        }
      }

      await client.query("COMMIT");

      return res.json({
        success: true,
        template_id: newTemplateId,
        parent_template_id: parentTemplateId,
        version: newVersion,
        table_name: newTableName,
        message: "New version created due to breaking schema changes",
        changes: changes,
        is_new_version: true,
      });
    } else {
      // No breaking changes, update in place
      console.log("No breaking changes, updating in place");

      // Update template
      const updateRes = await client.query(
        `
        UPDATE checksheet_templates 
        SET 
          name = $1,
          html_content = $2,
          field_configurations = $3,
          field_positions = $4,
          sheets = $5,
          css_content = $6,
          original_html_content = $7,
          access_control = $8,
          updated_at = NOW()
        WHERE id = $9
        RETURNING id, name
        `,
        [
          name,
          html_content || "",
          field_configurations ? JSON.stringify(field_configurations) : null,
          field_positions ? JSON.stringify(field_positions) : null,
          sheets ? JSON.stringify(sheets) : null,
          css_content || "",
          original_html_content || "",
          access_control ? JSON.stringify(access_control) : null,
          id,
        ]
      );

      // Clear existing fields
      await client.query("DELETE FROM template_fields WHERE template_id = $1", [
        id,
      ]);

      // Save new field configurations
      if (
        field_configurations &&
        Object.keys(field_configurations).length > 0
      ) {
        for (const [fieldId, config] of Object.entries(field_configurations)) {
          await client.query(
            `
            INSERT INTO template_fields
            (template_id, field_name, field_type, label, decimal_places, options,
             bg_color, text_color, exact_match_text, exact_match_bg_color,
             min_length, min_length_mode, min_length_warning_bg,
             max_length, max_length_mode, max_length_warning_bg,
             multiline, auto_shrink_font,
             min_value, max_value, bg_color_in_range, bg_color_below_min,
             bg_color_above_max, border_color_in_range, border_color_below_min,
             border_color_above_max, formula, position, instance_id, sheet_index,
             date_format, show_time_select, DatetimeFormat, min_date, max_date,
             allow_camera, allow_upload,
             max_file_size, time_format, allow_seconds, min_time, max_time,
             required, disabled, mode, allow_text_input, allow_signature, allow_signature_over_text, 
             text_font_size)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47, $48, $49)
            `,
            [
              id,
              config.field_name || fieldId,
              config.type || "text",
              config.label || "",
              config.decimal_places || null,
              config.options ? JSON.stringify(config.options) : null,
              config.bgColor || "#ffffff",
              config.textColor || "#000000",
              config.exactMatchText || "",
              config.exactMatchBgColor || "#d4edda",
              config.minLength || null,
              config.minLengthMode || "warning",
              config.minLengthWarningBg || "#ffebee",
              config.maxLength || null,
              config.maxLengthMode || "warning",
              config.maxLengthWarningBg || "#fff3cd",
              config.multiline || false,
              config.autoShrinkFont !== false,
              config.min || null,
              config.max || null,
              config.bgColorInRange || "#ffffff",
              config.bgColorBelowMin || "#e3f2fd",
              config.bgColorAboveMax || "#ffebee",
              config.borderColorInRange || "#cccccc",
              config.borderColorBelowMin || "#2196f3",
              config.borderColorAboveMax || "#f44336",
              config.formula || "",
              config.position || "",
              config.instanceId || fieldId,
              config.sheetIndex || 0,
              config.dateFormat || "yyyy-MMMM-dd",
              config.showTimeSelect || false,
              config.DatetimeFormat || "HH:mm",
              config.minDate || null,
              config.maxDate || null,
              config.allowCamera || false,
              config.allowUpload || false,
              config.maxFileSize || null,
              config.timeFormat || "HH:mm:ss",
              config.allowSeconds || false,
              config.minTime || null,
              config.maxTime || null,
              config.required || false,
              config.disabled || false,
              config.mode || "signature_over_text",
              config.allowTextInput !== false,
              config.allowSignature !== false,
              config.allowSignatureOverText !== false,
              config.textFontSize || 16,
            ]
          );
        }
      }

      await client.query("COMMIT");

      return res.json({
        success: true,
        template_id: id,
        message: "Form updated successfully",
        is_version_update: false,
        changes: changes,
      });
    }
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Update form error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to update form",
      details: err.message,
    });
  } finally {
    client.release();
  }
});

module.exports = router;
