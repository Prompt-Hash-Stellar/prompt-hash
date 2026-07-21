import { screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarketplaceFilters } from "./MarketplaceFilters";
import { renderWithProviders } from "@/test/render";

const defaultProps = {
  categories: ["AI", "Marketing", "Code"],
  tags: ["popular", "new"],
  selectedCategory: "",
  setSelectedCategory: vi.fn(),
  searchQuery: "",
  setSearchQuery: vi.fn(),
  selectedTag: "",
  setSelectedTag: vi.fn(),
  priceRange: [0, 25] as [number, number],
  setPriceRange: vi.fn(),
  sortBy: "recent",
  setSortBy: vi.fn(),
  onClear: vi.fn(),
  selectedCreator: "",
  setSelectedCreator: vi.fn(),
  selectedAvailability: "active",
  setSelectedAvailability: vi.fn(),
};

describe("MarketplaceFilters", () => {
  it("renders category section header", () => {
    renderWithProviders(<MarketplaceFilters {...defaultProps} />);
    expect(screen.getByText("Category")).toBeInTheDocument();
  });

  it("renders all category badges", () => {
    renderWithProviders(<MarketplaceFilters {...defaultProps} />);
    expect(screen.getAllByText("All")).toHaveLength(2);
    expect(screen.getByText("AI")).toBeInTheDocument();
    expect(screen.getByText("Marketing")).toBeInTheDocument();
    expect(screen.getByText("Code")).toBeInTheDocument();
  });

  it("renders tag section when tags are provided", () => {
    renderWithProviders(<MarketplaceFilters {...defaultProps} />);
    expect(screen.getByText("Tags")).toBeInTheDocument();
    expect(screen.getByText("popular")).toBeInTheDocument();
    expect(screen.getByText("new")).toBeInTheDocument();
  });

  it("does not render tag section when tags are empty", () => {
    renderWithProviders(
      <MarketplaceFilters {...defaultProps} tags={[]} />,
    );
    expect(screen.queryByText("Tags")).not.toBeInTheDocument();
  });

  it("renders price range section with min/max labels", () => {
    renderWithProviders(<MarketplaceFilters {...defaultProps} />);
    expect(screen.getByText("Price Range")).toBeInTheDocument();
    expect(screen.getByText("Min")).toBeInTheDocument();
    expect(screen.getByText("Max")).toBeInTheDocument();
  });

  it("displays current price range values", () => {
    renderWithProviders(
      <MarketplaceFilters {...defaultProps} priceRange={[5, 20]} />,
    );
    expect(screen.getByText("5 – 20 XLM")).toBeInTheDocument();
  });

  it("renders sort section", () => {
    renderWithProviders(<MarketplaceFilters {...defaultProps} />);
    expect(screen.getByText("Sort By")).toBeInTheDocument();
  });

  it("does not show Clear All button when no filters are active", () => {
    renderWithProviders(<MarketplaceFilters {...defaultProps} />);
    expect(screen.queryByText("Clear All Filters")).not.toBeInTheDocument();
  });

  it("shows Clear All button when a category is selected", () => {
    renderWithProviders(
      <MarketplaceFilters {...defaultProps} selectedCategory="AI" />,
    );
    expect(screen.getByText("Clear All Filters")).toBeInTheDocument();
  });

  it("shows Clear All button when sort is not recent", () => {
    renderWithProviders(
      <MarketplaceFilters {...defaultProps} sortBy="sales" />,
    );
    expect(screen.getByText("Clear All Filters")).toBeInTheDocument();
  });

  it("shows Clear All button when price range is changed", () => {
    renderWithProviders(
      <MarketplaceFilters {...defaultProps} priceRange={[5, 25]} />,
    );
    expect(screen.getByText("Clear All Filters")).toBeInTheDocument();
  });

  it("calls onClear when Clear All is clicked", () => {
    const onClear = vi.fn();
    renderWithProviders(
      <MarketplaceFilters {...defaultProps} selectedCategory="AI" onClear={onClear} />,
    );
    screen.getByText("Clear All Filters").click();
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("renders min price range input", () => {
    renderWithProviders(<MarketplaceFilters {...defaultProps} />);
    const minInput = screen.getByLabelText("Minimum price in XLM");
    expect(minInput).toBeInTheDocument();
    expect(minInput.getAttribute("type")).toBe("range");
  });

  it("renders max price range input", () => {
    renderWithProviders(<MarketplaceFilters {...defaultProps} />);
    const maxInput = screen.getByLabelText("Maximum price in XLM");
    expect(maxInput).toBeInTheDocument();
    expect(maxInput.getAttribute("type")).toBe("range");
  });

  it("renders creator address section header and input", () => {
    renderWithProviders(<MarketplaceFilters {...defaultProps} />);
    expect(screen.getByText("Creator Address / Name")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Filter by creator address or name")
    ).toBeInTheDocument();
  });

  it("calls setSelectedCreator when typing in creator input", () => {
    const setSelectedCreator = vi.fn();
    renderWithProviders(
      <MarketplaceFilters
        {...defaultProps}
        setSelectedCreator={setSelectedCreator}
      />
    );
    const input = screen.getByLabelText("Filter by creator address or name");
    fireEvent.change(input, { target: { value: "GD1234" } });
    expect(setSelectedCreator).toHaveBeenCalledWith("GD1234");
  });

  it("renders availability dropdown", () => {
    renderWithProviders(<MarketplaceFilters {...defaultProps} />);
    expect(screen.getByText("Availability")).toBeInTheDocument();
    expect(screen.getByText("On Sale (Active)")).toBeInTheDocument();
  });

  it("shows Clear All button when a creator is selected", () => {
    renderWithProviders(
      <MarketplaceFilters {...defaultProps} selectedCreator="GD1234" />
    );
    expect(screen.getByText("Clear All Filters")).toBeInTheDocument();
  });

  it("shows Clear All button when availability is not active", () => {
    renderWithProviders(
      <MarketplaceFilters {...defaultProps} selectedAvailability="inactive" />
    );
    expect(screen.getByText("Clear All Filters")).toBeInTheDocument();
  });
});
