const express = require("express");
const router = express.Router();
const pool = require("../../db");

// ==============================
// PUBLISH FORM TEMPLATE WITH PROPER IMAGE POSITIONS
// ==============================
router.post("/templates", async (req, res) => {
  const {
    name,
    html_content, // HTML with placeholders
    original_html_content, // Original HTML
    field_configurations,
    field_positions,
    sheets,
    form_values,
    css_content = "",
    images = {}, // Base64 images data
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

    // 1. Insert template
    const templateRes = await client.query(
      `
      INSERT INTO checksheet_templates 
      (name, html_content, field_configurations, field_positions, sheets, css_content, original_html_content)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
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
      ]
    );

    const templateId = templateRes.rows[0].id;
    console.log("Template created with ID:", templateId);

    // 2. ANALYZE IMAGE POSITIONS IN HTML
    const imagePositions = [];

    if (html_content) {
      // Find all img tags in HTML
      const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
      let match;
      let index = 0;

      while ((match = imgRegex.exec(html_content)) !== null) {
        const fullTag = match[0];
        const src = match[1];

        // Extract filename from src
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

      console.log(
        `Found ${imagePositions.length} images in HTML at positions:`,
        imagePositions.map((ip) => `${ip.position}: ${ip.filename}`)
      );
    }

    // 3. Save images with position information
    const savedImages = {};
    if (images && Object.keys(images).length > 0) {
      // Create array to maintain order
      const imageEntries = Object.entries(images);

      // Sort images by position, then by order
      imageEntries.sort((a, b) => {
        const posA = a[1].position !== undefined ? a[1].position : a[1].order;
        const posB = b[1].position !== undefined ? b[1].position : b[1].order;
        return posA - posB;
      });

      console.log(
        "Sorted images for saving:",
        imageEntries.map(
          ([name, data]) =>
            `${name}: position=${data.position}, order=${data.order}`
        )
      );

      // Keep track of used positions to avoid duplicates
      const usedPositions = new Set();

      for (let i = 0; i < imageEntries.length; i++) {
        const [originalPath, imageData] = imageEntries[i];

        try {
          // Get position from imageData
          let positionIndex =
            imageData.position !== undefined ? imageData.position : i;

          // If position is already used, find next available
          if (usedPositions.has(positionIndex)) {
            console.log(
              `Position ${positionIndex} already used for ${originalPath}, finding next available`
            );
            let newPos = positionIndex;
            while (usedPositions.has(newPos)) {
              newPos++;
            }
            positionIndex = newPos;
            console.log(
              `Assigned new position ${positionIndex} to ${originalPath}`
            );
          }

          usedPositions.add(positionIndex);

          // Find matching original src
          let originalSrc = "";
          if (imageData.originalSrc) {
            originalSrc = imageData.originalSrc;
          } else {
            // Try to find in imagePositions
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

          // Generate a unique element ID for this image
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

          console.log(
            `Saved image: ${imageData.filename} at position ${positionIndex} with ID: ${imageId}`
          );
        } catch (imgErr) {
          console.error(`Failed to save image ${originalPath}:`, imgErr);
          // Continue with other images
        }
      }
    }

    // 4. Update HTML to replace placeholders with API endpoints using correct positions
    let processedHtml = html_content;
    if (Object.keys(savedImages).length > 0) {
      // Sort saved images by position
      const sortedImages = Object.entries(savedImages)
        .map(([path, data]) => ({ path, ...data }))
        .sort((a, b) => a.position - b.position);

      console.log(
        "Sorted images by position for HTML processing:",
        sortedImages.map(
          (img) => `${img.position}: ${img.filename} (ID: ${img.id})`
        )
      );

      // Replace IMAGE_PLACEHOLDER:path with API endpoints
      for (const img of sortedImages) {
        const filename = img.filename || img.path.split("/").pop();

        // Multiple patterns to catch different placeholder formats
        const patterns = [
          // Pattern for IMAGE_PLACEHOLDER:filename
          new RegExp(
            `src=["']IMAGE_PLACEHOLDER:${filename.replace(
              /[.*+?^${}()|[\]\\]/g,
              "\\$&"
            )}["']`,
            "gi"
          ),
          // Pattern for blob URLs that might still exist
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
            console.log(
              `Replaced ${filename} with API URL at position ${img.position}`
            );
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
   required, disabled)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44)
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
          ]
        );
      }
    }

    // 6. Create dynamic table for submissions
    const tableName = `checksheet_${templateId}_${Date.now()}`.toLowerCase();
    const tableFields = [];

    if (field_configurations && Object.keys(field_configurations).length > 0) {
      Object.values(field_configurations).forEach((config) => {
        const fieldName = config.field_name || config.instanceId;
        if (fieldName && fieldName.trim()) {
          // Sanitize field name for SQL
          const safeFieldName = fieldName
            .replace(/[^a-zA-Z0-9_]/g, "_") // Replace non-alphanumeric with underscore
            .replace(/_{2,}/g, "_") // Replace multiple underscores with single
            .replace(/^_+|_+$/g, ""); // Remove leading/trailing underscores

          if (safeFieldName) {
            tableFields.push(`${safeFieldName} TEXT`);
          }
        }
      });
    }

    let createTableSQL;

    if (tableFields.length > 0) {
      createTableSQL = `
    CREATE TABLE IF NOT EXISTS "${tableName}" (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      submitted_at TIMESTAMP DEFAULT NOW(),
      ${tableFields.join(", ")}
    )
  `;
    } else {
      // Create table without additional fields if none exist
      createTableSQL = `
    CREATE TABLE IF NOT EXISTS "${tableName}" (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      submitted_at TIMESTAMP DEFAULT NOW()
    )
  `;
    }

    console.log("Creating table with SQL:", createTableSQL);

    try {
      await client.query(createTableSQL);
      console.log(`Table ${tableName} created successfully`);
    } catch (createTableErr) {
      console.error("Error creating table:", createTableErr);
      // Try alternative approach
      await client.query(`
        CREATE TABLE IF NOT EXISTS "${tableName}" (
          id SERIAL PRIMARY KEY,
          user_id INTEGER,
          submitted_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Add columns separately
      if (tableFields.length > 0) {
        for (const fieldDef of tableFields) {
          const fieldName = fieldDef.split(" ")[0]; // Extract field name
          try {
            await client.query(`
              ALTER TABLE "${tableName}" 
              ADD COLUMN IF NOT EXISTS ${fieldName} TEXT
            `);
          } catch (alterErr) {
            console.warn(
              `Could not add column ${fieldName}:`,
              alterErr.message
            );
          }
        }
      }
    }

    // Update template with table name
    await client.query(
      `UPDATE checksheet_templates SET table_name = $1 WHERE id = $2`,
      [tableName, templateId]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      template_id: templateId,
      message: "Form published successfully",
      table_name: tableName,
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
    // First verify the template exists and image belongs to it
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

    // Convert base64 to buffer
    const buffer = Buffer.from(image_data, "base64");

    // Set headers
    res.setHeader("Content-Type", mime_type);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.setHeader("Cache-Control", "public, max-age=31536000"); // Cache for 1 year
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
    // Get template basic info including CSS
    const templateRes = await pool.query(
      `
      SELECT 
        id, name, html_content, field_configurations, 
        field_positions, sheets, table_name, created_at,
        css_content, original_html_content
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
        time_format, allow_seconds, min_time, max_time, required, disabled
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

    res.json({
      success: true,
      template: {
        ...template,
        fields: fields,
        images: images,
        image_count: images.length,
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

    // 1. Get template info
    const templateRes = await client.query(
      `SELECT id, name, table_name FROM checksheet_templates WHERE id = $1`,
      [template_id]
    );

    if (templateRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, message: "Template not found" });
    }

    const template = templateRes.rows[0];
    const submissionsTable = template.table_name;

    console.log("Template name:", template.name);
    console.log("Submissions table:", submissionsTable);

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
    // Convert all existing columns to lowercase for comparison
    const existingColumnsLower = existingColumns.map((col) =>
      col.toLowerCase()
    );

    // Create mapping of lowercase field names to actual column names
    const columnMap = {};
    existingColumns.forEach((col) => {
      columnMap[col.toLowerCase()] = col;
    });

    // Create mapping of field names (from template_fields) to their lowercase versions
    const fieldMapping = {};
    fieldsRes.rows.forEach((field) => {
      const fieldName = field.field_name;
      const instanceId = field.instance_id;

      // Map both original and lowercase versions
      const lowerFieldName = fieldName.toLowerCase();
      const lowerInstanceId = instanceId.toLowerCase();

      fieldMapping[fieldName] = { original: fieldName, lower: lowerFieldName };
      fieldMapping[instanceId] = {
        original: instanceId,
        lower: lowerInstanceId,
      };

      // Also map lowercase to original
      fieldMapping[lowerFieldName] = {
        original: fieldName,
        lower: lowerFieldName,
      };
      fieldMapping[lowerInstanceId] = {
        original: instanceId,
        lower: lowerInstanceId,
      };
    });

    console.log(
      "Column map (lowercase -> actual):",
      Object.keys(columnMap).length
    );
    console.log(
      "Field mapping (all variants):",
      Object.keys(fieldMapping).length
    );

    const submittedKeys = Object.keys(data);
    console.log("Submitted keys:", submittedKeys);

    // 5. Prepare columns and values for insertion
    const columnsToInsert = ["user_id"];
    let valuesToInsert = [user_id];

    // Track successful mappings
    const mappings = [];

    // Validate each submitted field against template fields
    for (const submittedKey of submittedKeys) {
      let matchedColumn = null;

      // Try to find the column using case-insensitive matching
      const submittedLower = submittedKey.toLowerCase();

      // Strategy 1: Direct lowercase match in columnMap
      if (columnMap[submittedLower]) {
        matchedColumn = columnMap[submittedLower];
        console.log(`✓ Direct match: "${submittedKey}" -> "${matchedColumn}"`);
      }
      // Strategy 2: Try to find through field mapping
      else if (fieldMapping[submittedKey] || fieldMapping[submittedLower]) {
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
        valuesToInsert.push(data[submittedKey]);
        mappings.push({ submitted: submittedKey, column: matchedColumn });
      } else {
        console.warn(`⚠️ No column found for field: "${submittedKey}"`);
        console.warn(`  Tried lowercase: "${submittedLower}"`);

        // Try to suggest similar columns
        const suggestions = existingColumns.filter(
          (col) =>
            col.toLowerCase().includes(submittedLower) ||
            submittedLower.includes(col.toLowerCase())
        );

        if (suggestions.length > 0) {
          console.warn(`  Suggestions: ${suggestions.join(", ")}`);
        }
      }
    }

    console.log("Final columns to insert:", columnsToInsert);
    console.log("Mappings:", mappings);

    // 6. Validate we have data to insert
    if (columnsToInsert.length <= 1) {
      // Only user_id
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "No valid fields to insert. Check field names.",
        debug: {
          template_id: template_id,
          template_name: template.name,
          table: submissionsTable,
          existing_columns: existingColumns,
          field_names_in_db: fieldsRes.rows.map((f) => f.field_name),
          submitted_keys: submittedKeys,
          mappings: mappings,
          suggestions:
            "Field names might be case-sensitive. Check if field names in database match table columns.",
        },
      });
    }

    valuesToInsert = valuesToInsert.map((value, index) => {
      const columnName = columnsToInsert[index];

      // Check if this is a date column (by name pattern or from field type)
      const isDateColumn =
        columnName.includes("_date_") ||
        columnName.includes("start_") ||
        columnName.includes("end_") ||
        columnName.includes("time_");

      // Convert empty strings to null for date columns
      if (isDateColumn && (value === "" || value === undefined)) {
        console.log(
          `Converting empty date value to NULL for column: ${columnName}`
        );
        return null;
      }

      return value;
    });

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
    console.log("Values:", valuesToInsert);

    const submissionResult = await client.query(insertQuery, valuesToInsert);
    const submissionId = submissionResult.rows[0].id;
    const submittedAt = submissionResult.rows[0].submitted_at;

    console.log("✅ Insert successful, ID:", submissionId);

    // 8. AUTO-CREATE REPORT TABLE AND VIEW (only on first submission)
    const reportTableName = `${submissionsTable}_report`;
    const reportViewName = `${submissionsTable}_report_view`;

    // Check if report table already exists
    const tableExistsRes = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = '${reportTableName}'
      )
    `);

    const reportTableExists = tableExistsRes.rows[0].exists;

    if (!reportTableExists) {
      console.log(
        `First submission. Creating report table: ${reportTableName}`
      );

      // Create report table with all fields from this template (using lowercase column names)
      const createReportTableSQL = `
        CREATE TABLE "${reportTableName}" (
          report_id SERIAL PRIMARY KEY,
          submission_id INTEGER NOT NULL,
          template_id INTEGER NOT NULL,
          template_name VARCHAR(255) NOT NULL,
          user_id INTEGER NOT NULL,
          submitted_at TIMESTAMP NOT NULL,
          report_created_at TIMESTAMP DEFAULT NOW(),
          ${fieldsRes.rows
            .map((field) => {
              const columnName = (field.field_name || field.instance_id)
                .toLowerCase()
                .replace(/[^a-zA-Z0-9_]/g, "_")
                .replace(/_{2,}/g, "_")
                .replace(/^_+|_+$/g, "");

              // Determine column type based on field type
              let columnType = "TEXT";
              if (field.field_type === "number") {
                columnType = "DECIMAL(10,2)";
              } else if (field.field_type === "date") {
                columnType = "DATE";
              } else if (field.field_type === "datetime") {
                columnType = "TIMESTAMP";
              } else if (field.field_type === "boolean") {
                columnType = "BOOLEAN";
              }

              return `"${columnName}" ${columnType}`;
            })
            .join(",\n          ")}
        )
      `;

      await client.query(createReportTableSQL);
      console.log(`Created report table: ${reportTableName}`);

      // CREATE VIEW ONLY ONCE (first submission)
      const createViewSQL = `
        CREATE VIEW "${reportViewName}" AS
        SELECT 
          r.report_id,
          r.submission_id,
          r.template_id,
          r.template_name,
          r.user_id,
          r.submitted_at,
          r.report_created_at,
          ${fieldsRes.rows
            .map((field) => {
              const columnName = (field.field_name || field.instance_id)
                .toLowerCase()
                .replace(/[^a-zA-Z0-9_]/g, "_")
                .replace(/_{2,}/g, "_")
                .replace(/^_+|_+$/g, "");

              return `r."${columnName}" AS "${field.label || columnName}"`;
            })
            .join(",\n          ")}
        FROM "${reportTableName}" r
        ORDER BY r.submitted_at DESC
      `;

      await client.query(createViewSQL);
      console.log(`Created view: ${reportViewName}`);

      // Create indexes for performance
      await client.query(`
        CREATE INDEX idx_${reportTableName.replace(
          /[^a-zA-Z0-9_]/g,
          "_"
        )}_template_id 
        ON "${reportTableName}" (template_id);
        
        CREATE INDEX idx_${reportTableName.replace(
          /[^a-zA-Z0-9_]/g,
          "_"
        )}_submitted_at 
        ON "${reportTableName}" (submitted_at DESC);
      `);
      console.log(`Created indexes for ${reportTableName}`);
    }

    // 9. Insert data into report table (if it exists)
    if (reportTableExists) {
      console.log(
        `Report table exists, inserting data into: ${reportTableName}`
      );

      // Get columns from report table
      const reportColumnsRes = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = '${reportTableName}'
        AND column_name NOT IN (
          'report_id', 'submission_id', 'template_id', 'template_name', 
          'user_id', 'submitted_at', 'report_created_at'
        )
        ORDER BY ordinal_position
      `);

      const reportColumns = [
        "submission_id",
        "template_id",
        "template_name",
        "user_id",
        "submitted_at",
        ...reportColumnsRes.rows.map((row) => row.column_name),
      ];

      const reportPlaceholders = reportColumns
        .map((_, i) => `$${i + 1}`)
        .join(", ");

      // Prepare values for report table
      const reportValues = [
        submissionId,
        template_id,
        template.name,
        user_id,
        submittedAt,
      ];

      // Map submitted data to report table columns
      reportColumnsRes.rows.forEach((reportCol) => {
        let foundValue = null;

        // Try to find matching value from submitted data
        for (const [submittedKey, submittedValue] of Object.entries(data)) {
          const submittedLower = submittedKey.toLowerCase();
          const reportColLower = reportCol.column_name.toLowerCase();

          // Check if they match (case-insensitive)
          if (
            submittedLower === reportColLower ||
            submittedLower.replace(/_/g, "") ===
              reportColLower.replace(/_/g, "")
          ) {
            foundValue = submittedValue;
            break;
          }
        }

        reportValues.push(foundValue);
      });

      const safeReportCols = reportColumns.map((c) => `"${c}"`).join(", ");

      // In your code where you insert into the report table, look for this section:

      const insertReportQuery = `
  INSERT INTO "${reportTableName}" (${safeReportCols})
  VALUES (${reportPlaceholders})
  RETURNING report_id
`;

      // Add date conversion BEFORE executing this query:
      console.log("=== PROCESSING REPORT TABLE VALUES ===");

      // Create a map of column names to field types using fieldsRes data
      // Add date conversion BEFORE executing this query:
      console.log("=== PROCESSING REPORT TABLE VALUES ===");

      // Create a map of column names to field types using fieldsRes data
      const fieldTypeMap = {};
      fieldsRes.rows.forEach((field) => {
        const columnName = (field.field_name || field.instance_id)
          .toLowerCase()
          .replace(/[^a-zA-Z0-9_]/g, "_")
          .replace(/_{2,}/g, "_")
          .replace(/^_+|_+$/g, "");
        fieldTypeMap[columnName] = field.field_type;
      });

      console.log("Field type map for report table:", fieldTypeMap);

      const processedReportValues = reportValues.map((value, index) => {
        const columnName = reportColumns[index];

        // Skip metadata columns
        if (
          [
            "submission_id",
            "template_id",
            "template_name",
            "user_id",
            "submitted_at",
            "report_created_at",
          ].includes(columnName)
        ) {
          return value;
        }

        // Get the field type for this column
        const fieldType = fieldTypeMap[columnName];

        // Handle empty values based on field type
        if (value === "" || value === undefined || value === null) {
          // Convert empty strings to NULL for strict-type columns
          if (
            fieldType === "date" ||
            fieldType === "time" ||
            fieldType === "datetime" ||
            fieldType === "number" ||
            fieldType === "calculation"
          ) {
            console.log(
              `[REPORT] Converting empty ${fieldType} value to NULL for column: ${columnName}`
            );
            return null;
          }
          // For text fields, empty string is OK
          return value;
        }

        // For number fields, ensure they're valid numbers
        if (
          (fieldType === "number" || fieldType === "calculation") &&
          value !== null
        ) {
          const numValue = parseFloat(value);
          if (isNaN(numValue)) {
            console.log(
              `[REPORT] Invalid number "${value}" for column ${columnName}, converting to NULL`
            );
            return null;
          }
          return numValue; // Return as number, not string
        }

        return value;
      });

      console.log("Original report values:", reportValues);
      console.log("Processed report values:", processedReportValues);

      // Then use processedReportValues instead of reportValues
      const reportResult = await client.query(
        insertReportQuery,
        processedReportValues
      );

      console.log("Original report values:", reportValues);
      console.log("Processed report values:", processedReportValues);

      const reportId = reportResult.rows[0].report_id;
      console.log(`✅ Data inserted into report table, report ID: ${reportId}`);
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      submission_id: submissionId,
      submitted_at: submittedAt,
      template_name: template.name,
      message: "Form submitted successfully",
      report_created: !reportTableExists,
      report_table: reportTableExists ? reportTableName : null,
      report_view: reportTableExists ? reportViewName : null,
      debug: {
        fields_mapped: columnsToInsert.length - 1, // minus user_id
        total_fields: submittedKeys.length,
        mappings: mappings,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Submission error:", err);

    // Provide more detailed error information
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

    // 1. Get template info
    const templateRes = await client.query(
      "SELECT table_name FROM checksheet_templates WHERE id = $1",
      [id]
    );

    if (templateRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Template not found",
      });
    }

    const tableName = templateRes.rows[0].table_name;

    // 2. Delete dynamic table if exists
    if (tableName) {
      try {
        await client.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
      } catch (dropError) {
        console.warn(`Could not drop table ${tableName}:`, dropError.message);
      }
    }

    // 3. Delete images
    await client.query("DELETE FROM template_images WHERE template_id = $1", [
      id,
    ]);

    // 4. Delete field configurations
    await client.query("DELETE FROM template_fields WHERE template_id = $1", [
      id,
    ]);

    // 5. Delete template
    await client.query("DELETE FROM checksheet_templates WHERE id = $1", [id]);

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Template deleted successfully with all associated images",
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
router.get("/templates", async (req, res) => {
  try {
    const templatesRes = await pool.query(
      `SELECT 
        ct.id, 
        ct.name, 
        ct.table_name, 
        ct.created_at,
        ct.folder_id,
        ff.name as folder_name
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

module.exports = router;
