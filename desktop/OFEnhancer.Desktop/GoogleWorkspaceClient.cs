using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace OFEnhancer.Desktop;

internal interface IGoogleAccessTokenSource
{
    ValueTask<string> GetAccessTokenAsync(bool forceRefresh, CancellationToken cancellationToken);
}

internal sealed class GoogleWorkspaceClient
{
    private const string SpreadsheetMimeType = "application/vnd.google-apps.spreadsheet";
    private const string ItemMetadataKey = "ofenhancer.item_id.v1";
    private const int MaximumDriveResponseBytes = 64 * 1024;
    private const int MaximumMetadataResponseBytes = 256 * 1024;
    private const int MaximumWorkbookResponseBytes = 16 * 1024 * 1024;
    private const int MaximumMutationResponseBytes = 1024 * 1024;
    private const int MaximumValuesRequestBytes = 1024 * 1024;
    internal const int MaximumStructuralRequestBytes = 4 * 1024 * 1024;
    internal const int MaximumStructuralRequestCount = 5_016;
    private const int MaximumSheets = 100;
    private static readonly Uri DriveOrigin = new("https://www.googleapis.com");
    private static readonly Uri SheetsOrigin = new("https://sheets.googleapis.com");
    private const string SpreadsheetMetadataFields =
        "spreadsheetId,properties(title),sheets(properties(sheetId,title,hidden,gridProperties(rowCount,columnCount)))";
    private const string WorkbookFields =
        "spreadsheetId,properties(title),sheets(properties(sheetId,title,hidden,gridProperties(rowCount,columnCount)),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,formattedValue,hyperlink,effectiveFormat(numberFormat(type)))),columnMetadata(hiddenByUser)),columnGroups(range(sheetId,dimension,startIndex,endIndex),depth,collapsed)),developerMetadata(metadataId,metadataKey,metadataValue,visibility,location(spreadsheet,sheetId,dimensionRange(sheetId,dimension,startIndex,endIndex)))";
    private readonly HttpClient _httpClient;
    private readonly IGoogleAccessTokenSource _tokens;

    internal GoogleWorkspaceClient(HttpClient httpClient, IGoogleAccessTokenSource tokens)
    {
        _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
        _tokens = tokens ?? throw new ArgumentNullException(nameof(tokens));
    }

    internal async Task<GoogleSpreadsheetIdentity> ValidateSpreadsheetAsync(
        string fileId,
        CancellationToken cancellationToken
    )
    {
        string workbookId = Required(fileId, 256, "fileId");
        const string fields = "id,name,mimeType,capabilities(canEdit)";
        Uri endpoint = BuildUri(
            $"{DriveOrigin.AbsoluteUri.TrimEnd('/')}/drive/v3/files/{EscapePath(workbookId)}",
            [("fields", fields)]
        );
        byte[] body = await SendReadAsync(
            token => CreateJsonRequest(HttpMethod.Get, endpoint, token),
            DriveOrigin,
            MaximumDriveResponseBytes,
            cancellationToken
        ).ConfigureAwait(false);

        try
        {
            using JsonDocument json = JsonDocument.Parse(body, new() { MaxDepth = 8 });
            JsonElement root = RequireObject(json.RootElement);
            string id = ReadString(root, "id", 256);
            string title = ReadString(root, "name", 512);
            string mimeType = ReadString(root, "mimeType", 128);
            bool canEdit = root.TryGetProperty("capabilities", out JsonElement capabilities)
                && capabilities.ValueKind == JsonValueKind.Object
                && capabilities.TryGetProperty("canEdit", out JsonElement canEditValue)
                && canEditValue.ValueKind == JsonValueKind.True;
            if (!string.Equals(id, workbookId, StringComparison.Ordinal)
                || !string.Equals(mimeType, SpreadsheetMimeType, StringComparison.Ordinal)
                || !canEdit)
            {
                throw new GoogleCatalogueException("invalid-google-spreadsheet");
            }
            return new(id, title);
        }
        catch (GoogleCatalogueException)
        {
            throw;
        }
        catch
        {
            throw new GoogleCatalogueException("invalid-google-response");
        }
    }

    internal async Task<GoogleWorkbookSnapshot> ReadWorkbookAsync(
        string fileId,
        CancellationToken cancellationToken
    )
    {
        string workbookId = Required(fileId, 256, "fileId");
        string baseEndpoint = $"{SheetsOrigin.AbsoluteUri.TrimEnd('/')}/v4/spreadsheets/{EscapePath(workbookId)}";
        GoogleWorkbookSnapshot metadata = await ReadWorkbookMetadataAsync(
            workbookId,
            cancellationToken
        ).ConfigureAwait(false);

        List<(string Name, string Value)> query =
        [
            ("includeGridData", "true"),
            .. metadata.Sheets.Select(sheet => ("ranges", $"'{sheet.Title.Replace("'", "''", StringComparison.Ordinal)}'!A1:{(char)('A' + Math.Min(24, sheet.ColumnCount) - 1)}{Math.Min(5002, sheet.RowCount)}")),
            ("fields", WorkbookFields),
        ];
        Uri workbookEndpoint = BuildUri(baseEndpoint, query);
        byte[] workbookBody = await SendReadAsync(
            token => CreateJsonRequest(HttpMethod.Get, workbookEndpoint, token),
            SheetsOrigin,
            MaximumWorkbookResponseBytes,
            cancellationToken
        ).ConfigureAwait(false);
        GoogleWorkbookSnapshot snapshot = GoogleWorkbookSnapshot.Parse(workbookBody);
        if (!string.Equals(snapshot.WorkbookId, workbookId, StringComparison.Ordinal)
            || snapshot.Sheets.Count != metadata.Sheets.Count
            || snapshot.Sheets.Any(sheet => !metadata.Sheets.Any(candidate =>
                candidate.SheetId == sheet.SheetId && string.Equals(candidate.Title, sheet.Title, StringComparison.Ordinal))))
        {
            throw new GoogleCatalogueException("invalid-google-response");
        }
        return snapshot;
    }

    internal async Task<GoogleWorkbookSnapshot> ReadImportWorkbookAsync(string fileId, CancellationToken cancellationToken)
    {
        string workbookId = Required(fileId, 256, "fileId");
        GoogleWorkbookSnapshot metadata = await ReadWorkbookMetadataAsync(workbookId, cancellationToken).ConfigureAwait(false);
        GoogleSheetSnapshot[] visible = metadata.Sheets.Where(sheet =>
            !sheet.Hidden && sheet.RowCount > 0 && sheet.ColumnCount > 0).ToArray();
        if (visible.Length == 0)
            throw new GoogleCatalogueException("catalogue-tab-not-found");
        GoogleWorkbookSnapshot headers = await ReadImportRangesAsync(metadata, visible, headerDiscovery: true,
            cancellationToken).ConfigureAwait(false);
        GoogleCatalogueImportPreview discovered = GoogleCatalogueImportReader.Detect(headers);
        GoogleSheetSnapshot selected = headers.Sheets.Single(sheet => sheet.SheetId == discovered.CatalogueSheetId);
        if (selected.RowCount > 5002)
            throw new GoogleCatalogueException("workbook-row-limit");
        GoogleWorkbookSnapshot body = await ReadImportRangesAsync(metadata, [selected], headerDiscovery: false,
            cancellationToken).ConfigureAwait(false);
        GoogleCatalogueImportPreview verified = GoogleCatalogueImportReader.Detect(body);
        if (!discovered.HasSameMapping(verified))
            throw new GoogleCatalogueException("catalogue-layout-changed");
        return body;
    }

    internal async Task<GoogleSubredditPresetSnapshot> ReadSubredditPresetsAsync(string fileId, CancellationToken cancellationToken)
    {
        string workbookId=Required(fileId,256,"fileId");
        GoogleWorkbookSnapshot metadata=await ReadWorkbookMetadataAsync(workbookId,cancellationToken).ConfigureAwait(false);
        GoogleSheetSnapshot[] visible=metadata.Sheets.Where(sheet=>!sheet.Hidden && sheet.RowCount>0 && sheet.ColumnCount>0).ToArray();
        if(visible.Length==0) throw new GoogleCatalogueException("catalogue-tab-not-found");
        GoogleWorkbookSnapshot headers=await ReadImportRangesAsync(metadata,visible,true,cancellationToken).ConfigureAwait(false);
        GoogleCatalogueImportPreview detected=GoogleCatalogueImportReader.Detect(headers);
        GoogleSheetSnapshot selected=headers.Sheets.Single(sheet=>sheet.SheetId==detected.CatalogueSheetId);
        if(selected.ColumnCount<28) throw new GoogleCatalogueException("subreddit-presets-unavailable");
        int lastRow=Math.Min(501,selected.RowCount);
        string range=$"'{selected.Title.Replace("'","''",StringComparison.Ordinal)}'!Z1:AB{lastRow}";
        Uri endpoint=BuildUri($"{SheetsOrigin.AbsoluteUri.TrimEnd('/')}/v4/spreadsheets/{EscapePath(workbookId)}/values/{Uri.EscapeDataString(range)}",
            [("fields","range,values"),("valueRenderOption","FORMATTED_VALUE")]);
        byte[] body=await SendReadAsync(token=>CreateJsonRequest(HttpMethod.Get,endpoint,token),SheetsOrigin,4*1024*1024,cancellationToken).ConfigureAwait(false);
        GoogleWorkbookSnapshot verifiedMetadata=await ReadWorkbookMetadataAsync(workbookId,cancellationToken).ConfigureAwait(false);
        GoogleSheetSnapshot? identity=verifiedMetadata.Sheets.SingleOrDefault(sheet=>sheet.SheetId==selected.SheetId);
        if(identity is null || identity.Title!=selected.Title || identity.Hidden) throw new GoogleCatalogueException("subreddit-source-mismatch");
        return GoogleSubredditPresets.Parse(body,selected.Title,lastRow);
    }

    private async Task<GoogleWorkbookSnapshot> ReadImportRangesAsync(
        GoogleWorkbookSnapshot metadata, IReadOnlyList<GoogleSheetSnapshot> requestedSheets,
        bool headerDiscovery, CancellationToken cancellationToken)
    {
        string cells = headerDiscovery ? "formattedValue" : "effectiveValue,formattedValue,hyperlink,effectiveFormat(numberFormat(type))";
        string fields = $"spreadsheetId,properties(title),sheets(properties(sheetId,title,hidden,gridProperties(rowCount,columnCount)),data(startRow,startColumn,rowData(values({cells}))))";
        List<(string Name, string Value)> query = [("fields", fields)];
        foreach (GoogleSheetSnapshot sheet in requestedSheets)
        {
            char lastColumn = (char)('A' + Math.Min(sheet.ColumnCount, 24) - 1);
            int lastRow = Math.Min(sheet.RowCount, headerDiscovery ? 20 : 5002);
            query.Add(("ranges", $"'{sheet.Title.Replace("'", "''", StringComparison.Ordinal)}'!A1:{lastColumn}{lastRow}"));
        }
        Uri endpoint = BuildUri($"{SheetsOrigin.AbsoluteUri.TrimEnd('/')}/v4/spreadsheets/{EscapePath(metadata.WorkbookId)}", query);
        byte[] response = await SendReadAsync(token => CreateJsonRequest(HttpMethod.Get, endpoint, token),
            SheetsOrigin, MaximumWorkbookResponseBytes, cancellationToken).ConfigureAwait(false);
        GoogleWorkbookSnapshot snapshot = GoogleWorkbookSnapshot.Parse(response, headerDiscovery);
        if (!string.Equals(snapshot.WorkbookId, metadata.WorkbookId, StringComparison.Ordinal)
            || requestedSheets.Any(requested => !snapshot.Sheets.Any(sheet => sheet.SheetId == requested.SheetId))
            || snapshot.Sheets.Any(sheet => !metadata.Sheets.Any(original => original.SheetId == sheet.SheetId
                && original.Title == sheet.Title && original.Hidden == sheet.Hidden)))
            throw new GoogleCatalogueException("catalogue-layout-changed");
        // Retain every tab's identity, but expose data only from the ranges requested in this phase.
        return metadata with
        {
            Sheets = metadata.Sheets.Select(original => requestedSheets.Any(requested => requested.SheetId == original.SheetId)
                ? snapshot.Sheets.Single(sheet => sheet.SheetId == original.SheetId) : original).ToArray(),
        };
    }

    internal async Task<GoogleSheetIdentity> ReadSheetIdentityAsync(
        string fileId,
        int sheetId,
        CancellationToken cancellationToken
    )
    {
        string workbookId = Required(fileId, 256, "fileId");
        if (sheetId < 0)
            throw new GoogleCatalogueException("invalid-sheet-id");
        GoogleWorkbookSnapshot metadata = await ReadWorkbookMetadataAsync(
            workbookId,
            cancellationToken
        ).ConfigureAwait(false);
        GoogleSheetSnapshot[] matches = metadata.Sheets
            .Where(sheet => sheet.SheetId == sheetId)
            .ToArray();
        if (matches.Length != 1)
            throw new GoogleCatalogueException("invalid-google-response");
        return new(matches[0].SheetId, matches[0].Title);
    }

    private async Task<GoogleWorkbookSnapshot> ReadWorkbookMetadataAsync(
        string workbookId,
        CancellationToken cancellationToken
    )
    {
        string endpoint = $"{SheetsOrigin.AbsoluteUri.TrimEnd('/')}/v4/spreadsheets/{EscapePath(workbookId)}";
        Uri metadataEndpoint = BuildUri(endpoint, [("fields", SpreadsheetMetadataFields)]);
        byte[] metadataBody = await SendReadAsync(
            token => CreateJsonRequest(HttpMethod.Get, metadataEndpoint, token),
            SheetsOrigin,
            MaximumMetadataResponseBytes,
            cancellationToken
        ).ConfigureAwait(false);
        GoogleWorkbookSnapshot metadata = GoogleWorkbookSnapshot.Parse(metadataBody);
        if (!string.Equals(metadata.WorkbookId, workbookId, StringComparison.Ordinal))
            throw new GoogleCatalogueException("invalid-google-response");
        if (metadata.Sheets.Count > MaximumSheets)
            throw new GoogleCatalogueException("workbook-sheet-limit");
        return metadata;
    }

    internal async Task<IReadOnlyList<GoogleMetadataMatch>> SearchItemMetadataAsync(
        string fileId,
        string itemId,
        CancellationToken cancellationToken
    )
    {
        string workbookId = Required(fileId, 256, "fileId");
        string canonicalItemId = CanonicalGuid(itemId);
        Uri endpoint = new(
            $"{SheetsOrigin.AbsoluteUri.TrimEnd('/')}/v4/spreadsheets/{EscapePath(workbookId)}/developerMetadata:search"
        );
        byte[] requestBody = JsonSerializer.SerializeToUtf8Bytes(new
        {
            dataFilters = new[]
            {
                new
                {
                    developerMetadataLookup = new
                    {
                        metadataKey = ItemMetadataKey,
                        metadataValue = canonicalItemId,
                        locationType = "ROW",
                    },
                },
            },
        });
        byte[] responseBody = await SendReadAsync(
            token => CreateJsonRequest(HttpMethod.Post, endpoint, token, requestBody),
            SheetsOrigin,
            MaximumMetadataResponseBytes,
            cancellationToken
        ).ConfigureAwait(false);

        try
        {
            using JsonDocument json = JsonDocument.Parse(responseBody, new() { MaxDepth = 16 });
            JsonElement root = RequireObject(json.RootElement);
            if (!root.TryGetProperty("matchedDeveloperMetadata", out JsonElement matched))
                return [];
            if (matched.ValueKind != JsonValueKind.Array || matched.GetArrayLength() > 5_000)
                throw new GoogleCatalogueException("invalid-google-response");

            List<GoogleMetadataMatch> result = [];
            foreach (JsonElement wrapper in matched.EnumerateArray())
            {
                if (!wrapper.TryGetProperty("developerMetadata", out JsonElement metadata))
                    throw new GoogleCatalogueException("invalid-google-response");
                GoogleDeveloperMetadataSnapshot parsed = GoogleWorkbookSnapshot.ParseMetadata(metadata);
                if (!string.Equals(parsed.Key, ItemMetadataKey, StringComparison.Ordinal)
                    || !string.Equals(parsed.Value, canonicalItemId, StringComparison.Ordinal)
                    || !string.Equals(parsed.Visibility, "DOCUMENT", StringComparison.Ordinal)
                    || parsed.LocationKind != GoogleDeveloperMetadataLocationKind.DimensionRange
                    || !string.Equals(parsed.Dimension, "ROWS", StringComparison.Ordinal)
                    || parsed.SheetId < 0
                    || parsed.StartRowIndex < 0
                    || parsed.EndRowIndex != parsed.StartRowIndex + 1)
                {
                    throw new GoogleCatalogueException("invalid-google-response");
                }
                result.Add(new(parsed.MetadataId, parsed.Value, parsed.SheetId, parsed.StartRowIndex + 1));
            }
            return result;
        }
        catch (GoogleCatalogueException)
        {
            throw;
        }
        catch
        {
            throw new GoogleCatalogueException("invalid-google-response");
        }
    }

    internal async Task<GoogleProjectionCell> ReadProjectionCellAsync(
        string fileId,
        string range,
        CancellationToken cancellationToken
    )
    {
        string workbookId = Required(fileId, 256, "fileId");
        string boundedRange = Required(range, 512, "range");
        Uri endpoint = BuildUri(
            $"{SheetsOrigin.AbsoluteUri.TrimEnd('/')}/v4/spreadsheets/{EscapePath(workbookId)}/values/{EscapePath(boundedRange)}",
            [
                ("majorDimension", "ROWS"),
                ("valueRenderOption", "FORMULA"),
                ("dateTimeRenderOption", "FORMATTED_STRING"),
            ]
        );
        byte[] body = await SendReadAsync(
            token => CreateJsonRequest(HttpMethod.Get, endpoint, token),
            SheetsOrigin,
            MaximumDriveResponseBytes,
            cancellationToken
        ).ConfigureAwait(false);

        try
        {
            using JsonDocument json = JsonDocument.Parse(body, new() { MaxDepth = 8 });
            JsonElement root = RequireObject(json.RootElement);
            string returnedRange = root.TryGetProperty("range", out JsonElement rangeElement)
                && rangeElement.ValueKind == JsonValueKind.String
                ? Required(rangeElement.GetString(), 512, "range")
                : boundedRange;
            string? value = null;
            if (root.TryGetProperty("values", out JsonElement values))
            {
                if (values.ValueKind != JsonValueKind.Array || values.GetArrayLength() > 1)
                    throw new GoogleCatalogueException("invalid-google-response");
                if (values.GetArrayLength() == 1)
                {
                    JsonElement row = values[0];
                    if (row.ValueKind != JsonValueKind.Array || row.GetArrayLength() > 1)
                        throw new GoogleCatalogueException("invalid-google-response");
                    if (row.GetArrayLength() == 1)
                        value = GoogleWorkbookSnapshot.CellValue(row[0], 10_000);
                }
            }
            return new(returnedRange, value, Fingerprint(value));
        }
        catch (GoogleCatalogueException)
        {
            throw;
        }
        catch
        {
            throw new GoogleCatalogueException("invalid-google-response");
        }
    }

    internal Task ApplyStructuralBatchAsync(
        GoogleStructuralBatch batch,
        CancellationToken cancellationToken
    )
    {
        ArgumentNullException.ThrowIfNull(batch);
        string workbookId = Required(batch.WorkbookId, 256, "workbookId");
        if (batch.Requests is null || batch.Requests.Count is < 1 or > MaximumStructuralRequestCount
            || batch.Requests.Any(request => request.ValueKind != JsonValueKind.Object))
        {
            throw new GoogleCatalogueException("invalid-google-batch");
        }
        byte[] body = SerializeStructuralBatch(batch.Requests);
        return SendMutationAsync(
            new($"{SheetsOrigin.AbsoluteUri.TrimEnd('/')}/v4/spreadsheets/{EscapePath(workbookId)}:batchUpdate"),
            body,
            cancellationToken
        );
    }

    internal Task UpdateValuesBatchAsync(
        GoogleValuesBatch batch,
        CancellationToken cancellationToken,
        bool raw = false
    )
    {
        ArgumentNullException.ThrowIfNull(batch);
        string workbookId = Required(batch.WorkbookId, 256, "workbookId");
        if (batch.Updates is null || batch.Updates.Count is < 1 or > 100)
            throw new GoogleCatalogueException("invalid-google-batch");
        var updates = batch.Updates.Select(update => new
        {
            range = Required(update.Range, 512, "range"),
            majorDimension = "ROWS",
            values = new[] { new[] { Required(update.Value, MaximumValuesRequestBytes, "value", allowEmpty: true, allowLineBreaks: raw) } },
        }).ToArray();
        byte[] body = JsonSerializer.SerializeToUtf8Bytes(new
        {
            valueInputOption = raw ? "RAW" : "USER_ENTERED",
            data = updates,
        });
        EnsureRequestSize(body, MaximumValuesRequestBytes);
        return SendMutationAsync(
            new($"{SheetsOrigin.AbsoluteUri.TrimEnd('/')}/v4/spreadsheets/{EscapePath(workbookId)}/values:batchUpdate"),
            body,
            cancellationToken
        );
    }

    internal Task AppendCatalogueRowAsync(string workbookId, string sheetTitle,
        int headerRow, IReadOnlyDictionary<string, int> columns,
        string id, string releaseDate, string title, string description,
        CancellationToken cancellationToken)
    {
        string boundedWorkbook = Required(workbookId, 256, "workbookId");
        string boundedSheet = Required(sheetTitle, 200, "sheetTitle");
        if (headerRow is < 1 or > 20 || columns.Count is < 2 or > 24
            || !columns.TryGetValue("sourceKey", out int idColumn)
            || !columns.TryGetValue("title", out int titleColumn)
            || idColumn is < 1 or > 24 || titleColumn is < 1 or > 24)
            throw new GoogleCatalogueException("catalogue-layout-changed");
        int lastColumn = columns.Values.Max();
        if (lastColumn is < 1 or > 24) throw new GoogleCatalogueException("catalogue-layout-changed");
        string[] values = new string[lastColumn];
        values[idColumn - 1] = Required(id, 200, "id");
        values[titleColumn - 1] = Required(title, 300, "title");
        if (columns.TryGetValue("plannedDate", out int dateColumn))
            values[dateColumn - 1] = Required(releaseDate, 10, "releaseDate", allowEmpty: true);
        if (columns.TryGetValue("description", out int descriptionColumn))
            values[descriptionColumn - 1] = Required(description, 10_000, "description", allowEmpty: true, allowLineBreaks: true);
        string escapedSheet = boundedSheet.Replace("'", "''", StringComparison.Ordinal);
        string range = $"'{escapedSheet}'!A{headerRow + 1}:{(char)('A' + lastColumn - 1)}";
        byte[] body = JsonSerializer.SerializeToUtf8Bytes(new { majorDimension = "ROWS", values = new[] { values } });
        EnsureRequestSize(body, MaximumValuesRequestBytes);
        Uri endpoint = BuildUri(
            $"{SheetsOrigin.AbsoluteUri.TrimEnd('/')}/v4/spreadsheets/{EscapePath(boundedWorkbook)}/values/{Uri.EscapeDataString(range)}:append",
            [("valueInputOption", "RAW"), ("insertDataOption", "INSERT_ROWS")]);
        return SendMutationAsync(endpoint, body, cancellationToken);
    }

    internal Task UpdateMetadataCellAsync(string workbookId, int metadataId, int column, string value, CancellationToken cancellationToken)
    {
        if (metadataId < 0 || column is < 1 or > 24) throw new GoogleCatalogueException("invalid-google-batch");
        object?[] cells = new object?[column];
        cells[column - 1] = value;
        byte[] body = JsonSerializer.SerializeToUtf8Bytes(new {
            valueInputOption = "RAW",
            data = new[] { new { dataFilter = new { developerMetadataLookup = new { metadataId } }, majorDimension = "ROWS", values = new[] { cells } } }
        });
        EnsureRequestSize(body, MaximumValuesRequestBytes);
        return SendMutationAsync(new($"{SheetsOrigin.AbsoluteUri.TrimEnd('/')}/v4/spreadsheets/{EscapePath(Required(workbookId, 256, "fileId"))}/values:batchUpdateByDataFilter"), body, cancellationToken);
    }

    private async Task<byte[]> SendReadAsync(
        Func<string, HttpRequestMessage> createRequest,
        Uri expectedOrigin,
        int maximumResponseBytes,
        CancellationToken cancellationToken
    )
    {
        string token = await ReadTokenAsync(forceRefresh: false, cancellationToken).ConfigureAwait(false);
        using HttpResponseMessage first = await SendAsync(createRequest(token), cancellationToken).ConfigureAwait(false);
        if (first.StatusCode != HttpStatusCode.Unauthorized)
            return await ReadSuccessfulResponseAsync(first, expectedOrigin, maximumResponseBytes, cancellationToken).ConfigureAwait(false);

        string refreshed = await ReadTokenAsync(forceRefresh: true, cancellationToken).ConfigureAwait(false);
        using HttpResponseMessage second = await SendAsync(createRequest(refreshed), cancellationToken).ConfigureAwait(false);
        return await ReadSuccessfulResponseAsync(second, expectedOrigin, maximumResponseBytes, cancellationToken).ConfigureAwait(false);
    }

    private async Task SendMutationAsync(Uri endpoint, byte[] body, CancellationToken cancellationToken)
    {
        string token = await ReadTokenAsync(forceRefresh: false, cancellationToken).ConfigureAwait(false);
        try
        {
            using HttpResponseMessage response = await SendAsync(
                CreateJsonRequest(HttpMethod.Post, endpoint, token, body),
                cancellationToken
            ).ConfigureAwait(false);
            _ = await ReadSuccessfulResponseAsync(
                response,
                SheetsOrigin,
                MaximumMutationResponseBytes,
                cancellationToken
            ).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new GoogleMutationUncertainException();
        }
        catch (HttpRequestException)
        {
            throw new GoogleMutationUncertainException();
        }
    }

    private async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken
    )
    {
        using (request)
        {
            return await _httpClient.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken
            ).ConfigureAwait(false);
        }
    }

    private async ValueTask<string> ReadTokenAsync(bool forceRefresh, CancellationToken cancellationToken)
    {
        string token = await _tokens.GetAccessTokenAsync(forceRefresh, cancellationToken).ConfigureAwait(false);
        return Required(token, 8_192, "accessToken");
    }

    private static async Task<byte[]> ReadSuccessfulResponseAsync(
        HttpResponseMessage response,
        Uri expectedOrigin,
        int maximumBytes,
        CancellationToken cancellationToken
    )
    {
        Uri? responseUri = response.RequestMessage?.RequestUri;
        if (responseUri is null || !SameOrigin(responseUri, expectedOrigin))
            throw new GoogleCatalogueException("unexpected-google-origin");
        if (!response.IsSuccessStatusCode)
            throw new GoogleCatalogueException("google-request-failed");
        return await ReadBoundedAsync(response.Content, maximumBytes, cancellationToken).ConfigureAwait(false);
    }

    private static async Task<byte[]> ReadBoundedAsync(
        HttpContent content,
        int maximumBytes,
        CancellationToken cancellationToken
    )
    {
        if (content.Headers.ContentLength > maximumBytes)
            throw new GoogleCatalogueException("google-response-too-large");
        await using Stream input = await content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        using MemoryStream output = new(Math.Min(maximumBytes, 8_192));
        byte[] buffer = new byte[8_192];
        while (true)
        {
            int remaining = maximumBytes + 1 - checked((int)output.Length);
            int read = await input.ReadAsync(buffer.AsMemory(0, Math.Min(buffer.Length, remaining)), cancellationToken)
                .ConfigureAwait(false);
            if (read == 0)
                return output.ToArray();
            output.Write(buffer, 0, read);
            if (output.Length > maximumBytes)
                throw new GoogleCatalogueException("google-response-too-large");
        }
    }

    private static HttpRequestMessage CreateJsonRequest(
        HttpMethod method,
        Uri endpoint,
        string token,
        byte[]? body = null
    )
    {
        HttpRequestMessage request = new(method, endpoint);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (body is not null)
            request.Content = new ByteArrayContent(body) { Headers = { ContentType = new("application/json") } };
        return request;
    }

    private static byte[] SerializeStructuralBatch(IReadOnlyList<JsonElement> requests)
    {
        using MemoryStream output = new();
        using (Utf8JsonWriter writer = new(output))
        {
            writer.WriteStartObject();
            writer.WritePropertyName("requests");
            writer.WriteStartArray();
            foreach (JsonElement request in requests)
                request.WriteTo(writer);
            writer.WriteEndArray();
            writer.WriteEndObject();
        }
        byte[] body = output.ToArray();
        EnsureRequestSize(body, MaximumStructuralRequestBytes);
        return body;
    }

    private static void EnsureRequestSize(byte[] body, int maximumBytes)
    {
        if (body.Length > maximumBytes)
            throw new GoogleCatalogueException("google-request-too-large");
    }

    private static Uri BuildUri(string path, IEnumerable<(string Name, string Value)> parameters)
    {
        string query = string.Join("&", parameters.Select(pair =>
            $"{Uri.EscapeDataString(pair.Name)}={Uri.EscapeDataString(pair.Value)}"));
        return new Uri(query.Length == 0 ? path : $"{path}?{query}", UriKind.Absolute);
    }

    private static string EscapePath(string value) => Uri.EscapeDataString(value).Replace("%2F", "%2F", StringComparison.OrdinalIgnoreCase);

    private static bool SameOrigin(Uri left, Uri right) =>
        string.Equals(left.Scheme, right.Scheme, StringComparison.Ordinal)
        && string.Equals(left.IdnHost, right.IdnHost, StringComparison.Ordinal)
        && left.Port == right.Port;

    private static JsonElement RequireObject(JsonElement value) =>
        value.ValueKind == JsonValueKind.Object ? value : throw new GoogleCatalogueException("invalid-google-response");

    private static string ReadString(JsonElement root, string property, int maximumLength)
    {
        if (!root.TryGetProperty(property, out JsonElement value) || value.ValueKind != JsonValueKind.String)
            throw new GoogleCatalogueException("invalid-google-response");
        return Required(value.GetString(), maximumLength, property);
    }

    private static string Required(
        string? value,
        int maximumLength,
        string field,
        bool allowEmpty = false,
        bool allowLineBreaks = false
    )
    {
        string trimmed = value?.Trim() ?? string.Empty;
        if ((!allowEmpty && trimmed.Length == 0)
            || trimmed.Length > maximumLength
            || trimmed.Any(character => char.IsControl(character)
                && !(allowLineBreaks && character == '\n')))
        {
            throw new GoogleCatalogueException($"invalid-{field}");
        }
        return trimmed;
    }

    private static string CanonicalGuid(string value)
    {
        if (!Guid.TryParse(value, out Guid parsed))
            throw new GoogleCatalogueException("invalid-item-id");
        return parsed.ToString("D");
    }

    private static string Fingerprint(string? value) => Convert.ToHexString(
        SHA256.HashData(Encoding.UTF8.GetBytes(value ?? string.Empty))
    ).ToLowerInvariant();
}

internal sealed record GoogleSpreadsheetIdentity(string Id, string Title);

internal sealed record GoogleSheetIdentity(int SheetId, string Title);

internal sealed record GoogleWorkbookSnapshot(
    string WorkbookId,
    string Title,
    IReadOnlyList<GoogleSheetSnapshot> Sheets,
    IReadOnlyList<GoogleDeveloperMetadataSnapshot> DeveloperMetadata
)
{
    internal static GoogleWorkbookSnapshot Parse(byte[] utf8Json, bool headerDiscovery = false)
    {
        try
        {
            using JsonDocument json = JsonDocument.Parse(utf8Json, new() { MaxDepth = 32 });
            JsonElement root = json.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                throw Invalid();
            string workbookId = String(root, "spreadsheetId", 256);
            if (!root.TryGetProperty("properties", out JsonElement properties) || properties.ValueKind != JsonValueKind.Object)
                throw Invalid();
            string title = String(properties, "title", 512);
            if (!root.TryGetProperty("sheets", out JsonElement sheetsElement) || sheetsElement.ValueKind != JsonValueKind.Array
                || sheetsElement.GetArrayLength() > 100)
            {
                throw Invalid();
            }
            List<GoogleSheetSnapshot> sheets = [];
            HashSet<int> sheetIds = [];
            HashSet<string> sheetTitles = new(StringComparer.Ordinal);
            foreach (JsonElement sheet in sheetsElement.EnumerateArray())
            {
                if (!sheet.TryGetProperty("properties", out JsonElement sheetProperties)
                    || sheetProperties.ValueKind != JsonValueKind.Object)
                {
                    throw Invalid();
                }
                int sheetId = Integer(sheetProperties, "sheetId", 0, int.MaxValue);
                string sheetTitle = String(sheetProperties, "title", 100);
                bool hidden = sheetProperties.TryGetProperty("hidden", out JsonElement hiddenValue)
                    && hiddenValue.ValueKind == JsonValueKind.True;
                int rowCount = 0;
                int columnCount = 0;
                if (sheetProperties.TryGetProperty("gridProperties", out JsonElement gridProperties))
                {
                    if (gridProperties.ValueKind != JsonValueKind.Object)
                        throw Invalid();
                    rowCount = OptionalInteger(gridProperties, "rowCount", 0, 10_000_000);
                    columnCount = OptionalInteger(gridProperties, "columnCount", 0, 100_000);
                }
                if (!sheetIds.Add(sheetId) || !sheetTitles.Add(sheetTitle))
                    throw Invalid();
                IReadOnlyList<GoogleWorkbookRowSnapshot> rows = ParseRows(sheet, out IReadOnlySet<int> hiddenColumns, headerDiscovery);
                IReadOnlyList<GoogleDimensionGroupSnapshot> columnGroups = ParseColumnGroups(sheet, sheetId);
                sheets.Add(new(sheetId, sheetTitle, hidden, rowCount, columnCount, rows, hiddenColumns, columnGroups));
            }

            List<GoogleDeveloperMetadataSnapshot> metadata = [];
            if (root.TryGetProperty("developerMetadata", out JsonElement metadataElement))
            {
                if (metadataElement.ValueKind != JsonValueKind.Array || metadataElement.GetArrayLength() > 10_000)
                    throw Invalid();
                foreach (JsonElement entry in metadataElement.EnumerateArray())
                    metadata.Add(ParseMetadata(entry));
            }
            return new(workbookId, title, sheets, metadata);
        }
        catch (GoogleCatalogueException)
        {
            throw;
        }
        catch
        {
            throw Invalid();
        }
    }

    internal static GoogleDeveloperMetadataSnapshot ParseMetadata(JsonElement metadata)
    {
        if (metadata.ValueKind != JsonValueKind.Object
            || !metadata.TryGetProperty("location", out JsonElement location)
            || location.ValueKind != JsonValueKind.Object)
        {
            throw Invalid();
        }

        int metadataId = Integer(metadata, "metadataId", 1, int.MaxValue);
        string key = String(metadata, "metadataKey", 256);
        string value = String(metadata, "metadataValue", 256);
        string visibility = String(metadata, "visibility", 32);
        bool hasSpreadsheet = location.TryGetProperty("spreadsheet", out JsonElement spreadsheet);
        bool hasSheet = location.TryGetProperty("sheetId", out _);
        bool hasDimension = location.TryGetProperty("dimensionRange", out JsonElement range);
        if ((hasSpreadsheet ? 1 : 0) + (hasSheet ? 1 : 0) + (hasDimension ? 1 : 0) != 1)
            throw Invalid();

        if (hasSpreadsheet)
        {
            if (spreadsheet.ValueKind != JsonValueKind.True)
                throw Invalid();
            return new(
                metadataId,
                key,
                value,
                visibility,
                0,
                string.Empty,
                0,
                0,
                GoogleDeveloperMetadataLocationKind.Spreadsheet
            );
        }

        if (hasSheet)
        {
            return new(
                metadataId,
                key,
                value,
                visibility,
                Integer(location, "sheetId", 0, int.MaxValue),
                string.Empty,
                0,
                0,
                GoogleDeveloperMetadataLocationKind.Sheet
            );
        }

        if (range.ValueKind != JsonValueKind.Object)
            throw Invalid();
        return new(
            metadataId,
            key,
            value,
            visibility,
            Integer(range, "sheetId", 0, int.MaxValue),
            String(range, "dimension", 32),
            Integer(range, "startIndex", 0, 10_000_000),
            Integer(range, "endIndex", 1, 10_000_000),
            GoogleDeveloperMetadataLocationKind.DimensionRange
        );
    }

    internal static string? CellValue(JsonElement value, int maximumLength, bool allowTextWhitespace = false)
    {
        string? result = value.ValueKind switch
        {
            JsonValueKind.Null => null,
            JsonValueKind.String => value.GetString(),
            JsonValueKind.Number => value.GetRawText(),
            JsonValueKind.True => "TRUE",
            JsonValueKind.False => "FALSE",
            _ => throw Invalid(),
        };
        if (result is not null && (result.Length > maximumLength || result.Any(character =>
            char.IsControl(character) && !(allowTextWhitespace && character is '\r' or '\n' or '\t'))))
            throw Invalid();
        return result;
    }

    private static IReadOnlyList<GoogleWorkbookRowSnapshot> ParseRows(
        JsonElement sheet,
        out IReadOnlySet<int> hiddenColumns,
        bool headerDiscovery = false
    )
    {
        HashSet<int> hidden = [];
        hiddenColumns = hidden;
        if (!sheet.TryGetProperty("data", out JsonElement dataElement))
            return [];
        if (dataElement.ValueKind != JsonValueKind.Array || dataElement.GetArrayLength() > 100)
            throw Invalid();
        SortedDictionary<int, List<GoogleWorkbookCellSnapshot>> rows = [];
        foreach (JsonElement grid in dataElement.EnumerateArray())
        {
            int startRow = OptionalInteger(grid, "startRow", 0, 10_000_000);
            int startColumn = OptionalInteger(grid, "startColumn", 0, 23);
            if (grid.TryGetProperty("columnMetadata", out JsonElement columnMetadata))
            {
                if (columnMetadata.ValueKind != JsonValueKind.Array
                    || startColumn + columnMetadata.GetArrayLength() > 24)
                {
                    throw Invalid();
                }
                int columnIndex = startColumn;
                foreach (JsonElement column in columnMetadata.EnumerateArray())
                {
                    if (column.ValueKind != JsonValueKind.Object)
                        throw Invalid();
                    if (column.TryGetProperty("hiddenByUser", out JsonElement hiddenByUser)
                        && hiddenByUser.ValueKind == JsonValueKind.True)
                    {
                        hidden.Add(columnIndex);
                    }
                    columnIndex++;
                }
            }
            if (!grid.TryGetProperty("rowData", out JsonElement rowData))
                continue;
            if (rowData.ValueKind != JsonValueKind.Array || rowData.GetArrayLength() > 5_002)
                throw Invalid();
            int rowOffset = 0;
            foreach (JsonElement row in rowData.EnumerateArray())
            {
                int rowNumber = startRow + rowOffset + 1;
                rowOffset++;
                if (!rows.TryGetValue(rowNumber, out List<GoogleWorkbookCellSnapshot>? cells))
                {
                    cells = [];
                    rows.Add(rowNumber, cells);
                }
                if (!row.TryGetProperty("values", out JsonElement values))
                    continue;
                if (values.ValueKind != JsonValueKind.Array || startColumn + values.GetArrayLength() > 24)
                    throw Invalid();
                while (cells.Count < startColumn)
                    cells.Add(new(null, null));
                int column = startColumn;
                foreach (JsonElement cell in values.EnumerateArray())
                {
                    while (cells.Count <= column)
                        cells.Add(new(null, null));
                    cells[column] = ParseCell(cell, headerDiscovery);
                    column++;
                }
            }
        }
        return rows.Select(pair => new GoogleWorkbookRowSnapshot(pair.Key, pair.Value)).ToArray();
    }

    private static IReadOnlyList<GoogleDimensionGroupSnapshot> ParseColumnGroups(
        JsonElement sheet,
        int expectedSheetId
    )
    {
        if (!sheet.TryGetProperty("columnGroups", out JsonElement groups))
            return [];
        if (groups.ValueKind != JsonValueKind.Array || groups.GetArrayLength() > 100)
            throw Invalid();
        List<GoogleDimensionGroupSnapshot> result = [];
        foreach (JsonElement group in groups.EnumerateArray())
        {
            if (group.ValueKind != JsonValueKind.Object
                || !group.TryGetProperty("range", out JsonElement range)
                || range.ValueKind != JsonValueKind.Object
                || Integer(range, "sheetId", 0, int.MaxValue) != expectedSheetId
                || !string.Equals(String(range, "dimension", 32), "COLUMNS", StringComparison.Ordinal))
            {
                throw Invalid();
            }
            int startIndex = Integer(range, "startIndex", 0, 100_000);
            int endIndex = Integer(range, "endIndex", 1, 100_000);
            if (endIndex <= startIndex)
                throw Invalid();
            int depth = OptionalInteger(group, "depth", 1, 100);
            bool collapsed = group.TryGetProperty("collapsed", out JsonElement collapsedValue)
                && collapsedValue.ValueKind == JsonValueKind.True;
            result.Add(new(startIndex, endIndex, depth, collapsed));
        }
        return result;
    }

    private static GoogleWorkbookCellSnapshot ParseCell(JsonElement cell, bool headerDiscovery = false)
    {
        if (cell.ValueKind != JsonValueKind.Object)
            throw Invalid();
        if (headerDiscovery)
        {
            string? header = cell.TryGetProperty("formattedValue", out JsonElement displayed)
                && displayed.ValueKind == JsonValueKind.String ? displayed.GetString() : null;
            // Discovery needs short labels only; unrelated notes and content are not catalogue validation errors.
            return new(header?.Length <= 200 && !header.Any(char.IsControl) ? header : null, null);
        }
        string? value = null;
        if (cell.TryGetProperty("formattedValue", out JsonElement formatted))
            value = CellValue(formatted, 10_000, allowTextWhitespace: true);
        else if (cell.TryGetProperty("effectiveValue", out JsonElement effective))
        {
            if (effective.ValueKind != JsonValueKind.Object || effective.EnumerateObject().Count() > 1)
                throw Invalid();
            JsonProperty property = effective.EnumerateObject().SingleOrDefault();
            value = property.Name switch
            {
                "stringValue" => CellValue(property.Value, 10_000, allowTextWhitespace: true),
                "numberValue" => CellValue(property.Value, 10_000),
                "boolValue" => CellValue(property.Value, 10_000),
                "" => null,
                _ => throw Invalid(),
            };
        }
        if (cell.TryGetProperty("effectiveFormat", out JsonElement format)
            && format.TryGetProperty("numberFormat", out JsonElement numberFormat)
            && numberFormat.TryGetProperty("type", out JsonElement type)
            && type.GetString() is "DATE" or "DATE_TIME"
            && cell.TryGetProperty("effectiveValue", out JsonElement dateValue)
            && dateValue.TryGetProperty("numberValue", out JsonElement number))
        {
            if (dateValue.EnumerateObject().Count() != 1
                || !number.TryGetDouble(out double serial) || !double.IsFinite(serial))
                throw Invalid();
            // Google dates count days from 1899-12-30; display text depends on workbook locale.
            int days = checked((int)Math.Floor(serial));
            value = new DateOnly(1899, 12, 30).AddDays(days).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        }
        string? hyperlink = null;
        if (cell.TryGetProperty("hyperlink", out JsonElement hyperlinkValue))
            hyperlink = CellValue(hyperlinkValue, 2_048);
        string? formula = cell.TryGetProperty("userEnteredValue", out var entered) && entered.TryGetProperty("formulaValue", out var expression)
            ? CellValue(expression, 10_000, allowTextWhitespace: true) : null;
        return new(value, hyperlink, formula);
    }

    private static string String(JsonElement root, string property, int maximumLength)
    {
        if (!root.TryGetProperty(property, out JsonElement value) || value.ValueKind != JsonValueKind.String)
            throw Invalid();
        string? result = value.GetString();
        if (string.IsNullOrWhiteSpace(result) || result.Length > maximumLength || result.Any(char.IsControl))
            throw Invalid();
        return result;
    }

    private static int Integer(JsonElement root, string property, int minimum, int maximum)
    {
        if (!root.TryGetProperty(property, out JsonElement value)
            || !value.TryGetInt32(out int result)
            || result < minimum
            || result > maximum)
        {
            throw Invalid();
        }
        return result;
    }

    private static int OptionalInteger(JsonElement root, string property, int minimum, int maximum) =>
        root.TryGetProperty(property, out _) ? Integer(root, property, minimum, maximum) : minimum;

    private static GoogleCatalogueException Invalid() => new("invalid-google-response");
}

internal sealed record GoogleSheetSnapshot(
    int SheetId,
    string Title,
    bool Hidden,
    int RowCount,
    int ColumnCount,
    IReadOnlyList<GoogleWorkbookRowSnapshot> Rows,
    IReadOnlySet<int>? HiddenColumnIndexes = null,
    IReadOnlyList<GoogleDimensionGroupSnapshot>? ColumnGroups = null
);

internal sealed record GoogleDimensionGroupSnapshot(
    int StartIndex,
    int EndIndex,
    int Depth,
    bool Collapsed
);

internal sealed record GoogleWorkbookRowSnapshot(
    int RowNumber,
    IReadOnlyList<GoogleWorkbookCellSnapshot> Cells
);

internal sealed record GoogleWorkbookCellSnapshot(string? Value, string? Hyperlink, string? Formula = null);

internal sealed record GoogleDeveloperMetadataSnapshot(
    int MetadataId,
    string Key,
    string Value,
    string Visibility,
    int SheetId,
    string Dimension,
    int StartRowIndex,
    int EndRowIndex,
    GoogleDeveloperMetadataLocationKind LocationKind = GoogleDeveloperMetadataLocationKind.DimensionRange
);

internal enum GoogleDeveloperMetadataLocationKind
{
    Spreadsheet,
    Sheet,
    DimensionRange,
}

internal sealed record GoogleMetadataMatch(int MetadataId, string Value, int SheetId, int RowNumber);

internal sealed record GoogleProjectionCell(string Range, string? Value, string Fingerprint);

internal sealed record GoogleStructuralBatch(string WorkbookId, IReadOnlyList<JsonElement> Requests);

internal sealed record GoogleValueUpdate(string Range, string Value);

internal sealed record GoogleValuesBatch(string WorkbookId, IReadOnlyList<GoogleValueUpdate> Updates);

internal class GoogleCatalogueException(string code) : Exception(code)
{
    internal string Code { get; } = code;
}

internal sealed class GoogleMutationUncertainException() : GoogleCatalogueException("google-mutation-uncertain");
