# AeroTrack — Monthly Airline Demand Intelligence

A reproducible AI/ML capstone built on official U.S. Bureau of Transportation Statistics (BTS) airline passenger records. AeroTrack turns monthly traffic into an auditable **route-market review workflow**: inspect the data, prepare it, compare models on later months, and create a shortlist for human investigation.

## Project purpose

The practical question is: **Which airline–route–month markets look busy enough to merit a closer planning review, and how reliable is that signal on unseen months?**

The output is a screening shortlist, not an automatic service or capacity recommendation. Passenger counts alone cannot establish unmet demand. A real airline planning decision also needs schedules, seats, load factors, fares, bookings, costs, cancellations, and airport constraints. BTS T-100 Market is monthly reported traffic; it is not live flight tracking or a count of unique people.

## Official data

Source: U.S. BTS [T-100 Market (All Carriers)](https://www.transtats.bts.gov/TableInfo.asp?gnoyr_VQ=FMF). Supplied data covers January–December 2025 and January–July 2026 (partial year). The raw archives contain 519,402 records; Notebook 01 aggregates them into 503,224 carrier-route-month records. The two source years are official, but this is only one full training year and seven 2026 holdout months, so multi-year seasonality and business conclusions are not established.

## What a user can learn and do

1. **Understand the source:** every column’s data type, descriptive statistics, missing count and percentage, plus numeric/categorical field lists.
2. **Prepare responsibly:** column-by-column missing policy, validity checks, duplicate aggregation, categorical encoding, demand bins, skew transformation, scaling, and IQR outlier review.
3. **Explain features:** compare F-test, mutual information, and tree importance; report feature counts and use PCA on Iris as a separate required exercise.
4. **Train and evaluate:** simple, multiple, and polynomial regression; Logistic Regression, KNN, Gaussian Naive Bayes, SVM, Decision Tree; chronological 2025 train / 2026 test split; error and classification metrics.
5. **Use a decision aid:** export a 2026 year-to-date route-market watchlist with prediction, observed count, prediction gap, threshold, and a human-review note.
6. **Explore the work visually:** the browser GUI imports a user CSV, updates data summaries/charts/features and browser-based demonstrations, filters routes, compares forecasts, and exports filtered views. Saved full sklearn notebook results are clearly distinguished from live browser calculations.

## Project structure

```text
AeroTrack/
├── data/
│   ├── raw/                           # BTS source archives
│   └── processed/                     # Recreated by notebooks
├── notebooks/
│   ├── 00_data_and_scope.ipynb
│   ├── 01_preprocessing_and_eda.ipynb
│   ├── 02_encoding_and_feature_selection.ipynb
│   ├── 03_simple_linear_regression.ipynb
│   ├── 04_multiple_and_polynomial_regression.ipynb
│   ├── 05_logistic_regression.ipynb
│   ├── 06_pca_iris.ipynb
│   ├── 07_forecast_comparison_and_dashboard_export.ipynb
│   ├── 08_classification_model_comparison.ipynb
│   ├── 09_route_market_decision_support.ipynb
│   └── 10_lda_iris_extension.ipynb
├── index.html                         # Frontend
├── app.js                             # CSV import, interactive analysis, charts
├── styles.css                         # UI styling
├── requirements.txt
└── README.md
```

All analysis and model work is in `.ipynb` notebooks; there are no project `.py` files.

## Run from scratch

Open PowerShell in this folder, then run:

```powershell
py -m pip install -r requirements.txt
py -m jupyter lab
```

Run notebooks `00` through `10` in order. Notebook 01 rebuilds `data/processed/air_passenger_monthly.csv` from the official archives. Notebook 07 exports dashboard tables. Notebook 09 creates `data/processed/route_market_watchlist_2026_ytd.csv` (all scored 2026 route-months) and `data/processed/route_market_review_candidates_2026_ytd.csv` (only flagged review candidates). The Iris-only PCA and LDA notebooks are standalone labs.

To use the GUI, open `index.html` in a browser and import `data/processed/air_passenger_monthly.csv`. You can also import your own CSV if it has compatible date/month, route/carrier, distance, and passenger columns. The GUI's calculations are a lightweight browser demonstration; for the full scikit-learn model comparison and watchlist, run the notebooks.

## Workbook alignment

- **Data understanding:** full shape, all-column types, summary stats, missing count/percent, numerical/categorical split.
- **Missing values:** every raw column has a documented policy and reason; actual missing cells and applied row actions are reported. BTS fields may have no missing values, so the notebooks state when no imputation was needed rather than inventing one.
- **Encoding:** binary target maps to 0/1; route, airline-code, and airline-name text fields are one-hot encoded in the encoding lab; the duplicated carrier-name field is excluded from prediction pipelines; calendar month is cyclical. There is no naturally ordinal categorical input in the selected BTS fields, so no artificial ordinal order is imposed.
- **Binning and transforms:** equal-frequency demand tiers with observed boundaries, `log1p` for skew, and standardization where a model requires scale alignment. Binned target tiers are never fed back into a model predicting passenger counts.
- **Outliers:** IQR flags for passenger count and distance, with domain reasoning. Plausible high traffic and valid zeros are retained; only invalid values are removed.
- **Dimensionality reduction/selection:** F-test, mutual information, Extra Trees ranking; PCA 4→2 on Iris; LDA extension on Iris.
- **Training/evaluation:** chronological holdout, regression errors, classification precision/recall/F1/ROC-AUC/confusion matrix; classifier comparison includes Logistic Regression, KNN, Naive Bayes, SVM, and Decision Tree.
- **Breadth:** the core notebook set also includes Simple Linear Regression, Multiple Linear Regression, Polynomial Regression, Logistic Regression, and Iris PCA. The separate LDA exercise is an extension.

## Existing reference results

From saved original notebook runs: monthly seasonal-naive forecast MAE was 1.50 million passenger records over the 2026 holdout; linear trend MAE 8.47 million; polynomial trend MAE 29.21 million. Multiple regression had MAE 2,702 per carrier-route-month and R² 0.072. Logistic Regression had 79.1% accuracy, 85.8% high-demand recall, F1 0.669, and ROC-AUC 0.895. These reference results use the supplied BTS extract and are not guarantees for another upload. Notebook 08 classifier comparison on a proportional 6,000-row train and 6,000-row holdout sample: linear SVM had 73.7% accuracy, 82.0% recall, F1 0.606, and ROC-AUC 0.853; Logistic Regression had 73.7% accuracy, 81.8% recall, F1 0.606, and ROC-AUC 0.855; KNN reached 79.9% accuracy with 54.8% recall. Notebook 09 Random Forest capstone scored 185,891 2026 holdout route-months with MAE 2,864.7, RMSE 6,169.1, and R² 0.042; it flagged 11,421 records for human review. These are the saved results from the included dataset, not guarantees for another upload. Download the [11,421-row review shortlist](data/processed/route_market_review_candidates_2026_ytd.csv) or the [full scored watchlist](data/processed/route_market_watchlist_2026_ytd.csv).

## Limits and a credible next phase

The present data is appropriate for a strong academic prototype, not a complete commercial demand system. The next meaningful upgrade is to append more historical years and enrich each route-month with scheduled seats, load factors, fare/booking signals, cancellations, and operating constraints. Then compare models with rolling-origin validation, monitor drift, and attach uncertainty ranges. Until those inputs exist, the watchlist should prompt investigation, not direct operational action.
