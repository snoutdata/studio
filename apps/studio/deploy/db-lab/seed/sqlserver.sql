-----------------------------------------------------------------------------------------------
--  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
--  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
-----------------------------------------------------------------------------------------------

-- Seed for the SQL Server lab container (run by the sqlserver-init service via sqlcmd).
-- Creates the `lab` database, then the same customers/orders schema in T-SQL. Constraints
-- are named with the PK_<table> / DF_<table>_<col> convention SnoutData Studio's designer assumes.

IF DB_ID('lab') IS NULL CREATE DATABASE lab;
GO

USE lab;
GO

IF OBJECT_ID('dbo.orders', 'U') IS NOT NULL DROP TABLE dbo.orders;
IF OBJECT_ID('dbo.customers', 'U') IS NOT NULL DROP TABLE dbo.customers;
GO

CREATE TABLE dbo.customers (
	id INT IDENTITY(1,1) CONSTRAINT PK_customers PRIMARY KEY,
	email NVARCHAR(255) NOT NULL CONSTRAINT UQ_customers_email UNIQUE,
	name NVARCHAR(120) NOT NULL,
	created_at DATETIME2 NOT NULL CONSTRAINT DF_customers_created_at DEFAULT SYSUTCDATETIME()
);

CREATE TABLE dbo.orders (
	id INT IDENTITY(1,1) CONSTRAINT PK_orders PRIMARY KEY,
	customer_id INT NOT NULL,
	total DECIMAL(10,2) NOT NULL CONSTRAINT DF_orders_total DEFAULT 0,
	status NVARCHAR(20) NOT NULL CONSTRAINT DF_orders_status DEFAULT 'pending',
	CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES dbo.customers(id)
);

CREATE INDEX IX_orders_status ON dbo.orders(status);
GO

INSERT INTO dbo.customers (email, name) VALUES
	('ann@example.com', 'Ann'),
	('bob@example.com', 'Bob');

INSERT INTO dbo.orders (customer_id, total, status) VALUES
	(1, 19.99, 'paid'),
	(1, 5.00, 'pending'),
	(2, 99.00, 'paid');
GO
