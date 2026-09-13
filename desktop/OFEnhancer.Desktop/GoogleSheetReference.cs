using System.Globalization;
using System.Text.RegularExpressions;

namespace OFEnhancer.Desktop;

internal sealed partial record GoogleSheetReference(string WorkbookId, int? SheetId)
{
    internal string CanonicalUrl => SheetId is int sheetId
        ? $"https://docs.google.com/spreadsheets/d/{WorkbookId}/edit#gid={sheetId.ToString(CultureInfo.InvariantCulture)}"
        : $"https://docs.google.com/spreadsheets/d/{WorkbookId}/edit";

    internal static GoogleSheetReference Parse(string? value)
    {
        string candidate = value?.Trim() ?? string.Empty;
        if (candidate.Length is 0 or > 2048
            || !Uri.TryCreate(candidate, UriKind.Absolute, out Uri? uri)
            || uri.Scheme != Uri.UriSchemeHttps
            || !string.Equals(uri.Host, "docs.google.com", StringComparison.OrdinalIgnoreCase)
            || !uri.IsDefaultPort
            || !string.IsNullOrEmpty(uri.UserInfo))
            throw Invalid();

        Match path = SpreadsheetPath().Match(uri.AbsolutePath);
        if (!path.Success)
            throw Invalid();

        int? sheetId = null;
        string fragment = uri.Fragment.TrimStart('#');
        if (fragment.Length > 0)
        {
            string[][] pairs = fragment.Split('&', StringSplitOptions.RemoveEmptyEntries)
                .Select(part => part.Split('=', 2))
                .ToArray();
            string[] gids = pairs
                .Where(pair => pair.Length > 0 && string.Equals(pair[0], "gid", StringComparison.OrdinalIgnoreCase))
                .Select(pair => pair.ElementAtOrDefault(1) ?? string.Empty)
                .ToArray();
            if (gids.Length > 1)
                throw Invalid();
            if (gids.Length == 1)
            {
                string gid = gids[0];
                if (!int.TryParse(gid, NumberStyles.None, CultureInfo.InvariantCulture, out int parsed)
                    || parsed < 0)
                    throw Invalid();
                sheetId = parsed;
            }
        }

        return new(path.Groups[1].Value, sheetId);
    }

    private static GoogleSheetReferenceException Invalid() => new("invalid-google-sheet-url");

    [GeneratedRegex("^/spreadsheets/d/([A-Za-z0-9_-]{1,256})(?:/|$)", RegexOptions.CultureInvariant)]
    private static partial Regex SpreadsheetPath();
}

internal sealed class GoogleSheetReferenceException(string code) : Exception(code)
{
    internal string Code { get; } = code;
}
