-----------------------------------------------------------------------------------------------
--  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
--  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
-----------------------------------------------------------------------------------------------

-- Seed for the Postgres lab container (runs once, via /docker-entrypoint-initdb.d,
-- against database `lab` as user `snout`).

CREATE TABLE customers (
	id SERIAL PRIMARY KEY,
	email VARCHAR(255) NOT NULL UNIQUE,
	name VARCHAR(120) NOT NULL,
	created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE orders (
	id SERIAL PRIMARY KEY,
	customer_id INT NOT NULL REFERENCES customers(id),
	total NUMERIC(10,2) NOT NULL DEFAULT 0,
	status VARCHAR(20) NOT NULL DEFAULT 'pending'
);

CREATE INDEX idx_orders_status ON orders(status);

INSERT INTO customers (email, name) VALUES
	('ann@example.com', 'Ann'),
	('bob@example.com', 'Bob');

INSERT INTO orders (customer_id, total, status) VALUES
	(1, 19.99, 'paid'),
	(1, 5.00, 'pending'),
	(2, 99.00, 'paid');
