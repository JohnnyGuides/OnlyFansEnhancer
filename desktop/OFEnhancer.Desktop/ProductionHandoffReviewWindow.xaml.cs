using System.IO;
using System.Windows;
using System.Windows.Controls;
using OFEnhancer.Catalogue;
using OFEnhancer.Protocol;

namespace OFEnhancer.Desktop;

public partial class ProductionHandoffReviewWindow : Window
{
    private sealed record FileRow(string Name, string Role, string Size, string Path);
    private sealed record CatalogueOption(string Id, string Label);

    private readonly ProductionHandoffCoordinator coordinator;
    private readonly ProductionHandoffStatus draft;
    private readonly CancellationTokenSource reviewStop = new(TimeSpan.FromMinutes(30));
    private readonly CatalogueOption[] options;
    private string currentState = "";

    internal ProductionHandoffReviewWindow(ProductionHandoffStatus draft,
        IReadOnlyList<CatalogueItemSummary> catalogueItems,
        ProductionHandoffCoordinator coordinator)
    {
        InitializeComponent();
        this.coordinator = coordinator;
        this.draft = draft;
        EpisodeText.Text = $"{draft.EpisodeCode} · Edit {draft.EditNumber}";
        FilesList.ItemsSource = draft.Files.Select(file => new FileRow(
            Path.GetFileName(file.Path), file.Role.Replace("final-", ""),
            $"{file.Size / 1_000_000.0:0.#} MB", file.Path)).ToArray();
        options = catalogueItems.Where(item => !item.Archived)
            .Select(item => new CatalogueOption(item.ItemId,
                string.IsNullOrWhiteSpace(item.Episode)
                    ? item.Title : $"{item.Episode} · {item.Title}"))
            .OrderBy(item => item.Label, StringComparer.CurrentCultureIgnoreCase).ToArray();
        CatalogueChoice.ItemsSource = options.Take(30).ToArray();
        if (draft.CatalogueItemId is not null)
            CatalogueChoice.SelectedItem = options.FirstOrDefault(item => item.Id == draft.CatalogueItemId);
        UpdateState(draft.State);
        Closed += (_, _) => { reviewStop.Cancel(); reviewStop.Dispose(); };
    }

    private void UpdateState(string state)
    {
        currentState = state;
        StatusText.Text = state switch
        {
            "awaiting-review" => "Awaiting review",
            "changed-source" => "Source changed",
            "bound" => "Bound",
            "rejected" => "Rejected",
            _ => "Check draft"
        };
        RejectButton.IsEnabled = state == "awaiting-review";
        CatalogueSearch.IsEnabled = state == "awaiting-review";
        CatalogueChoice.IsEnabled = state == "awaiting-review";
        BindButton.IsEnabled = state == "awaiting-review" && CatalogueChoice.SelectedItem is not null;
    }

    private void CatalogueChoice_SelectionChanged(object sender, SelectionChangedEventArgs e) =>
        BindButton.IsEnabled = currentState == "awaiting-review" && CatalogueChoice.SelectedItem is not null;

    private void CatalogueSearch_TextChanged(object sender, TextChangedEventArgs e)
    {
        if (options is null) return;
        var query = CatalogueSearch.Text.Trim();
        CatalogueChoice.ItemsSource = options.Where(item =>
            item.Label.Contains(query, StringComparison.CurrentCultureIgnoreCase))
            .Take(30).ToArray();
    }

    private void LaterButton_Click(object sender, RoutedEventArgs e) => Close();

    private async void RejectButton_Click(object sender, RoutedEventArgs e) =>
        await ReviewAsync("rejected", null);

    private async void BindButton_Click(object sender, RoutedEventArgs e)
    {
        if (CatalogueChoice.SelectedItem is CatalogueOption item)
            await ReviewAsync("bound", item.Id);
    }

    private async Task ReviewAsync(string decision, string? catalogueItemId)
    {
        BindButton.IsEnabled = false;
        RejectButton.IsEnabled = false;
        CatalogueSearch.IsEnabled = false;
        CatalogueChoice.IsEnabled = false;
        StatusText.Text = "Checking files";
        try
        {
            var result = await coordinator.ReviewAsync(draft.HandoffId, decision,
                catalogueItemId, reviewStop.Token);
            UpdateState(result.State);
            Close();
        }
        catch (OperationCanceledException) when (reviewStop.IsCancellationRequested) { }
        catch (Exception error)
        {
            UpdateState(error is ProductionHandoffException { Code: "changed-source" }
                ? "changed-source" : draft.State);
            System.Windows.MessageBox.Show(this, error.Message, "Production draft", MessageBoxButton.OK,
                MessageBoxImage.Warning);
        }
    }
}
